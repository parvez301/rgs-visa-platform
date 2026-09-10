import { z } from "zod";
import type { AppContext } from "../lib/context";
import type { TableItem } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import {
  collectReadableRecords,
  describeFirstZodIssue,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../lib/storedRecords";
import { getCase } from "../domain/crm/cases";
import { recordCrmEvent } from "../domain/crm/crmEvents";
import { PROPOSAL_SORT_KEY, proposalPartitionKey, proposalStatusGsi1Pk } from "../domain/crm/keys";
import { ToolRegistry, type AgentTool } from "./tools/registry";
import { WRITE_TOOLS } from "./tools/writeTools";

/**
 * A domain mutation a write tool wants to make, staged for a human to approve
 * before it happens. Every write tool's `execute` (registry.ts) builds and
 * returns one of these and touches the table not at all; `apply` is the half
 * that actually calls the domain mutator, and `applyApprovedChange` below is
 * its only caller.
 */
export interface ProposedChange {
  proposalId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable diff for the UI card: field, from, to. */
  summary: { field: string; from: string; to: string }[];
  caseId?: string;
  proposedBy: string; // actor email
  proposedAt: string;
  status: "PENDING" | "APPROVED" | "DISCARDED";
  /** Set once the proposal leaves PENDING -- who moved it, and when. */
  decidedBy?: string;
  decidedAt?: string;
  /** Set only on a DISCARDED proposal: the human's own account of what was wrong. */
  discardReason?: string;
}

/**
 * The write-path/read-path schema for a stored proposal. `ProposedChange`
 * above stays a plain interface -- the type every write tool's `execute`
 * already returns and is typechecked against (ruling P35) -- and this is
 * the separate validator a *stored* row is parsed back through, the same
 * split `reviewQueue.ts` uses between `crm.ReviewItem` and
 * `crm.ReviewItemSchema`.
 */
const ProposedChangeSchema = z.object({
  proposalId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
  summary: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
  caseId: z.string().optional(),
  proposedBy: z.string().min(1),
  proposedAt: z.string(),
  status: z.enum(["PENDING", "APPROVED", "DISCARDED"]),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  discardReason: z.string().optional(),
});

/**
 * Never auto-applied, at any trust level: money, and a terminal billing
 * state. `add_line_item` changes what the client owes; `set_billing` can move
 * a case to PAID, which is effectively irreversible in practice even though
 * the state machine allows further moves. The trust ladder (Task 10) may
 * relax over time, but this is the set it can never relax past.
 */
export const HIGH_STAKES_TOOLS: ReadonlySet<string> = new Set(["add_line_item", "set_billing"]);

/**
 * The ONLY tools a trust level may apply without staging. A write tool added
 * later is staged until someone puts it here on purpose -- the default has
 * to be the safe one (fail SAFE, ruling P46), because forgetting to add a
 * line to an allow-list is silent, and what it silently permits is staying
 * conservative (everything stays staged). Forgetting to add a line to a
 * DENY-list is also silent, but what THAT silently permits is an unreviewed
 * write reaching the database -- which is why HIGH_STAKES_TOOLS alone is not
 * enough to gate auto-apply, and Task 10 must consult this set first.
 */
export const AUTO_APPLIABLE_TOOLS: ReadonlySet<string> = new Set([
  "create_case",
  "update_case",
  "set_custody",
]);

/** Built once from the same WRITE_TOOLS array the loop and the tests use. */
const writeToolRegistry = new ToolRegistry(WRITE_TOOLS);

/**
 * Looks up a write tool by name for dispatch, the only thing that stands in
 * for a `switch (toolName)` in this design (task-8-controller-notes.md §1,
 * §P39): a tool absent from the registry, or present under a `kind` other
 * than `"write"`, is refused rather than silently reaching `apply`.
 */
function requireWriteTool(toolName: string): AgentTool {
  const tool = writeToolRegistry.get(toolName);
  if (tool === undefined) {
    throw notFound(`Write tool "${toolName}"`);
  }
  if (tool.kind !== "write" || tool.apply === undefined) {
    throw badRequest(`"${toolName}" is not a write tool and cannot be applied`);
  }
  return tool;
}

/**
 * The single place a proposal reaches storage, at any status.
 *
 * GSI1PK is re-derived from the proposal's own `status` on every write, the
 * same rule `reviewQueue.ts` uses (its comment at :201-210) so an approved or
 * discarded proposal leaves the PENDING partition automatically instead of
 * lingering there forever because nobody re-wrote it.
 */
async function putProposal(
  context: AppContext,
  tenantId: string,
  proposal: ProposedChange,
): Promise<void> {
  await context.table.put({
    PK: proposalPartitionKey(tenantId, proposal.proposalId),
    SK: PROPOSAL_SORT_KEY,
    GSI1PK: proposalStatusGsi1Pk(tenantId, proposal.status),
    GSI1SK: proposal.proposedAt,
    ...proposal,
  });
}

function parseStoredProposal(storedItem: TableItem): ProposedChange {
  return parseStoredRecord(
    ProposedChangeSchema,
    "Agent proposal",
    storedRecordId(storedItem, "proposalId"),
    stripStorageKeys(storedItem),
  );
}

/**
 * Stages a proposal exactly as a write tool's `execute` produced it.
 *
 * Takes a complete `ProposedChange`, not `Omit<..., "proposalId" |
 * "proposedAt" | "status">`: ruling P35 made every write tool's `execute`
 * mint its own `proposalId`/`proposedAt` because the loop hands that id back
 * to the user immediately, before staging happens. Re-minting them here would
 * hand the user an id that this function then overwrites with a different
 * one (task-8-controller-notes.md P43).
 */
export async function stageProposal(
  context: AppContext,
  tenantId: string,
  proposal: ProposedChange,
): Promise<ProposedChange> {
  if (proposal.status !== "PENDING") {
    throw badRequest(`A staged proposal must start PENDING, not ${proposal.status}`);
  }
  await putProposal(context, tenantId, proposal);
  return proposal;
}

export interface PendingProposalListing {
  proposals: ProposedChange[];
  /**
   * Ids of PENDING rows that could not be read back as a `ProposedChange`.
   * Named rather than merely absent, so a proposal vanishing from the queue
   * does not look like a proposal that was never staged (the same rule
   * `PartnerListing` documents, and `reviewQueue.ts` follows).
   */
  unreadableProposalIds: string[];
}

export async function listPendingProposals(
  context: AppContext,
  tenantId: string,
): Promise<PendingProposalListing> {
  const storedItems = await context.table.queryGsi("GSI1", proposalStatusGsi1Pk(tenantId, "PENDING"));
  const { records, unreadableRecordIds } = await collectReadableRecords(storedItems, parseStoredProposal, {
    entityDescription: "agent proposal",
    scopeDescription: `tenant ${tenantId}`,
  });
  return { proposals: records, unreadableProposalIds: unreadableRecordIds };
}

async function readProposalOrThrow(
  context: AppContext,
  tenantId: string,
  proposalId: string,
): Promise<ProposedChange> {
  const storedItem = await context.table.get(proposalPartitionKey(tenantId, proposalId), PROPOSAL_SORT_KEY);
  if (storedItem === undefined) {
    throw notFound(`Proposal ${proposalId}`);
  }
  return parseStoredProposal(storedItem);
}

function extractCaseId(domainResult: unknown): string | undefined {
  if (typeof domainResult !== "object" || domainResult === null || !("caseId" in domainResult)) {
    return undefined;
  }
  const caseId = (domainResult as { caseId: unknown }).caseId;
  return typeof caseId === "string" ? caseId : undefined;
}

function extractUpdatedAt(domainResult: unknown): string | undefined {
  if (typeof domainResult !== "object" || domainResult === null || !("updatedAt" in domainResult)) {
    return undefined;
  }
  const updatedAt = (domainResult as { updatedAt: unknown }).updatedAt;
  return typeof updatedAt === "string" ? updatedAt : undefined;
}

/**
 * Whether `apply` actually moved anything (ruling P53).
 *
 * `updateCaseDetails` (ruling P51) returns the case exactly as it read it --
 * the identical `updatedAt` -- when every supplied field already matches
 * what's stored, rather than performing a no-op write. Every mutator in
 * `cases.ts` that DOES write sets `updatedAt` from `context.now()`, so a real
 * change always advances it. Comparing the case's `updatedAt` immediately
 * before `apply` runs against the domain result's own `updatedAt` afterward
 * is the cheapest honest signal available without coupling this function to
 * any one tool's internals.
 *
 * A proposal with no `caseId` (only `create_case`) has nothing to compare
 * against and is definitionally a change -- a case now exists that did not
 * before.
 */
function domainCallChanged(
  caseIdBeforeApply: string | undefined,
  caseUpdatedAtBeforeApply: string | undefined,
  domainResult: unknown,
): boolean {
  if (caseIdBeforeApply === undefined) return true;
  return extractUpdatedAt(domainResult) !== caseUpdatedAtBeforeApply;
}

/**
 * The ONLY path from a proposal to the database. Every write tool's
 * `execute` only ever proposes; this is what calls a write tool's `apply`,
 * looked up through the registry rather than a `switch (toolName)`
 * (task-8-controller-notes.md §1) -- so a write tool added to `WRITE_TOOLS`
 * without wiring anything here is still reachable, and one that is NOT in
 * `WRITE_TOOLS` (or not a write tool at all) is refused.
 */
export async function applyApprovedChange(
  context: AppContext,
  tenantId: string,
  proposalId: string,
  actorEmail: string,
  editedInput?: Record<string, unknown>,
): Promise<unknown> {
  const proposal = await readProposalOrThrow(context, tenantId, proposalId);
  if (proposal.status !== "PENDING") {
    throw conflict(`Proposal ${proposalId} is already ${proposal.status}`);
  }

  const writeTool = requireWriteTool(proposal.toolName);

  // The human's edit wins over the model's original suggestion (AX
  // Principle 3), but it is untrusted input like any other input this system
  // accepts: re-validate it against the tool's own schema before it reaches
  // `apply`, so a schema-violating edit is refused with nothing written,
  // rather than handed straight to the domain function.
  let effectiveInput: Record<string, unknown> = proposal.input;
  if (editedInput !== undefined) {
    const parsedEdit = writeTool.inputSchema.safeParse(editedInput);
    if (!parsedEdit.success) {
      throw badRequest(`Edited input for proposal ${proposalId}: ${describeFirstZodIssue(parsedEdit.error)}`);
    }
    effectiveInput = parsedEdit.data as Record<string, unknown>;
  }

  // Snapshotted before `apply` runs -- it is the "before" side of the
  // comparison `domainCallChanged` needs, and reading it after `apply` would
  // just read back whatever `apply` itself did or didn't do.
  const caseUpdatedAtBeforeApply =
    proposal.caseId !== undefined ? (await getCase(context, tenantId, proposal.caseId)).updatedAt : undefined;

  const domainResult = await writeTool.apply!(context, tenantId, effectiveInput, actorEmail);

  const decidedAt = context.now().toISOString();
  const approvedProposal: ProposedChange = {
    ...proposal,
    input: effectiveInput,
    status: "APPROVED",
    decidedBy: actorEmail,
    decidedAt,
  };
  await putProposal(context, tenantId, approvedProposal);

  const changed = domainCallChanged(proposal.caseId, caseUpdatedAtBeforeApply, domainResult);
  // create_case has no caseId at stage time -- the case does not exist until
  // `apply` returns. Recording only `if (proposal.caseId !== undefined)`
  // would leave the single highest-consequence approval in the system with
  // no audit trail at all (P42); take the id off the domain result instead.
  const recordedCaseId = proposal.caseId ?? extractCaseId(domainResult);
  if (recordedCaseId !== undefined) {
    await recordCrmEvent(context, tenantId, recordedCaseId, "PROPOSAL_APPROVED", actorEmail, {
      proposalId,
      toolName: proposal.toolName,
      edited: editedInput !== undefined,
      changed,
    });
  }

  return domainResult;
}

export async function discardProposal(
  context: AppContext,
  tenantId: string,
  proposalId: string,
  actorEmail: string,
  reason: string,
): Promise<ProposedChange> {
  const proposal = await readProposalOrThrow(context, tenantId, proposalId);
  if (proposal.status !== "PENDING") {
    throw conflict(`Proposal ${proposalId} is already ${proposal.status}`);
  }
  if (reason.trim() === "") {
    throw badRequest("Discarding a proposal needs a reason; nothing goes quiet without a trace");
  }

  const decidedAt = context.now().toISOString();
  const discardedProposal: ProposedChange = {
    ...proposal,
    status: "DISCARDED",
    decidedBy: actorEmail,
    decidedAt,
    discardReason: reason,
  };
  await putProposal(context, tenantId, discardedProposal);

  if (proposal.caseId !== undefined) {
    await recordCrmEvent(context, tenantId, proposal.caseId, "PROPOSAL_DISCARDED", actorEmail, {
      proposalId,
      toolName: proposal.toolName,
      reason,
    });
  }
  return discardedProposal;
}
