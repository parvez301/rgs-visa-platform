import { crm } from "@rgs/shared";
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
  // .min(1), not a bare .optional(): absent stays legal (a PENDING proposal
  // has no decidedBy yet), but an empty string does not -- it is the
  // backstop against an admin token with no email claim approving or
  // discarding a proposal as "" (task-11-fix-1-review.md M3). The route
  // layer (agentApi.ts's requireAdminEmail) is where this is actually
  // prevented; this is what refuses it a second time, on read, if any call
  // site ever forgets.
  decidedBy: z.string().min(1).optional(),
  decidedAt: z.string().optional(),
  discardReason: z.string().optional(),
});

/**
 * Never auto-applied, at any trust level: money, and a terminal billing
 * state. `add_line_item` changes what the client owes; `set_billing` can move
 * a case to PAID, which is effectively irreversible in practice even though
 * the state machine allows further moves. The trust ladder (Task 10) may
 * relax over time, but this is the set it can never relax past.
 *
 * `remember` and `forget` join them (ruling P46, task-9-controller-notes.md
 * §5): spec §7 says memories are "staged and confirmed like any other
 * write, never silently absorbed," and `forget` is a deletion -- neither
 * belongs in an auto-apply allow-list at any trust level.
 */
export const HIGH_STAKES_TOOLS: ReadonlySet<string> = new Set([
  "add_line_item",
  "set_billing",
  "remember",
  "forget",
]);

/**
 * The ONLY tools a trust level may apply without staging. A write tool added
 * later is staged until someone puts it here on purpose -- the default has
 * to be the safe one (fail SAFE, ruling P46), because forgetting to add a
 * line to an allow-list is silent, and what it silently permits is staying
 * conservative (everything stays staged). Forgetting to add a line to a
 * DENY-list is also silent, but what THAT silently permits is an unreviewed
 * write reaching the database -- which is why HIGH_STAKES_TOOLS alone is not
 * enough to gate auto-apply, and Task 10 must consult this set first.
 *
 * Deliberately NOT required to cover `WRITE_TOOLS` (fix-round-1 ruling): a
 * union-covers assertion forces every non-high-stakes tool into this set by
 * construction, which collapses "not high-stakes" into "auto-appliable" and
 * defeats the default-deny property the set exists for. A write tool may be
 * absent from BOTH sets on purpose -- staged for a reason other than money
 * or a terminal state.
 *
 * `create_case` is one such absence, on purpose: opening a brand-new case
 * with no human in the loop is not obviously low-stakes, and spec §7's
 * level-2 wording does not compel auto-applying it. Do not "fix" this gap by
 * adding it back without a deliberate decision to do so.
 */
export const AUTO_APPLIABLE_TOOLS: ReadonlySet<string> = new Set(["update_case", "set_custody"]);

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
    // A stored proposal that exists (readProposalOrThrow above already found
    // it) and names a tool this registry does not have is a corrupt record,
    // not a missing one -- the same distinction parseStoredRecord makes for
    // a row that will not reassemble. `conflict` (409), not `notFound`, so
    // this is distinguishable from the 404 a genuinely absent proposal id
    // returns (m5).
    throw conflict(`Proposal names an unregistered write tool "${toolName}"`);
  }
  if (tool.kind !== "write" || tool.apply === undefined) {
    // Unreachable by construction: writeToolRegistry (above) is built only
    // from WRITE_TOOLS, and writeTools.test.ts already pins every member's
    // `kind` as "write" with a defined `apply`. Kept anyway, and documented
    // rather than deleted, so a future change to how this registry is built
    // (e.g. making it injectable) fails loudly here instead of silently
    // reaching `apply` on a non-write tool (Minor 3).
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

/**
 * Reads a proposal back at whatever status the store actually holds, rather
 * than the PENDING `readProposalOrThrow` below requires. `undefined` only
 * when the row is genuinely absent -- a read or parse failure still throws,
 * the same as `readProposalOrThrow`, because both are "the read-back itself
 * failed" from a caller's point of view, not "nothing is there."
 *
 * Exported for `loop.ts`'s trust ladder (fix-round-2, finding N1): after
 * `applyApprovedChange` throws, the only way to know whether it failed
 * before or after the domain mutation actually ran is to look, not to
 * assume -- see the comment on `applyApprovedChange`'s catch site in
 * `loop.ts` for the reasoning, and `services/migration/src/importCli.ts`'s
 * `tableRecordingWrites` for the precedent this follows (observe the
 * outcome, do not infer it from the fact that something threw).
 */
export async function getProposal(
  context: AppContext,
  tenantId: string,
  proposalId: string,
): Promise<ProposedChange | undefined> {
  const storedItem = await context.table.get(proposalPartitionKey(tenantId, proposalId), PROPOSAL_SORT_KEY);
  if (storedItem === undefined) return undefined;
  return parseStoredProposal(storedItem);
}

async function readProposalOrThrow(
  context: AppContext,
  tenantId: string,
  proposalId: string,
): Promise<ProposedChange> {
  const proposal = await getProposal(context, tenantId, proposalId);
  if (proposal === undefined) {
    throw notFound(`Proposal ${proposalId}`);
  }
  return proposal;
}

function extractCaseId(domainResult: unknown): string | undefined {
  if (typeof domainResult !== "object" || domainResult === null || !("caseId" in domainResult)) {
    return undefined;
  }
  const caseId = (domainResult as { caseId: unknown }).caseId;
  return typeof caseId === "string" ? caseId : undefined;
}

/**
 * Whether `apply` actually moved anything (ruling P53).
 *
 * `updateCaseDetails` (ruling P51) returns the case exactly as it read it
 * when every supplied field already matches what's stored, rather than
 * performing a no-op write. A first version of this signal compared only
 * `updatedAt` before vs. after -- cheap, but clock-racy: production runs a
 * live clock (`context.now()` in `src/http/handler.ts`), but two calls close
 * enough together can still land in the same millisecond, and a frozen test
 * clock (as `buildTestContext()` provides) makes a REAL write's freshly
 * recomputed `updatedAt` byte-identical to the snapshot whenever the test
 * doesn't itself advance the clock -- silently reporting `changed: false`
 * for a change that did happen (fix-round-1 Major 3).
 *
 * A full deep compare against the pre-apply snapshot has no such race: it is
 * exact regardless of whether or how far the clock moved, and it is free --
 * the snapshot read already happens for this signal, once per apply.
 *
 * A proposal with no `caseId` (only `create_case`) has nothing to compare
 * against and is definitionally a change -- a case now exists that did not
 * before.
 */
function domainCallChanged(caseBeforeApply: crm.CrmCase | undefined, domainResult: unknown): boolean {
  if (caseBeforeApply === undefined) return true;
  return JSON.stringify(domainResult) !== JSON.stringify(caseBeforeApply);
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
  // Set only by the trust ladder (Task 10) when it stages a change and
  // applies it in the same breath, with no human ever having seen it.
  // `decidedBy` stays `actorEmail` either way -- that is genuinely who the
  // turn was running for -- but `decidedBy` alone would make this call
  // indistinguishable from a human clicking Approve on the same proposal
  // (task-10-controller-notes.md §3). Threaded through to the recorded
  // event below rather than left implicit, because this repo has already
  // shipped one message that lied about what happened (the importer's abort
  // text, finding NEW-4) and paid for it in review.
  autoApplied = false,
): Promise<unknown> {
  const proposal = await readProposalOrThrow(context, tenantId, proposalId);
  if (proposal.status !== "PENDING") {
    throw conflict(`Proposal ${proposalId} is already ${proposal.status}`);
  }

  const writeTool = requireWriteTool(proposal.toolName);

  // Untrusted input like any other, whichever source it comes from: the
  // human's edit wins over the model's original suggestion when supplied (AX
  // Principle 3), but `proposal.input` is not pre-validated either --
  // `stageProposal` checks only `status` -- so both sources get the same
  // guarantee from one unconditional validation rather than only the edited
  // one (Minor 2, fix-round-1). A schema-violating input of either kind is
  // refused with nothing written, never handed to `apply`. The message names
  // which side was at fault -- "Edited input" vs. "Input" -- so a Task 11
  // caller can tell whether it was the human's edit or the model's original
  // proposal that failed (fix-round-2).
  const parsedInput = writeTool.inputSchema.safeParse(editedInput ?? proposal.input);
  if (!parsedInput.success) {
    const rejectedInputDescription = editedInput !== undefined ? "Edited input" : "Input";
    throw badRequest(
      `${rejectedInputDescription} for proposal ${proposalId}: ${describeFirstZodIssue(parsedInput.error)}`,
    );
  }
  // The value actually handed to `apply` -- always the validated/coerced
  // parse, on either source, so `apply` never sees a schema-violating shape.
  // What gets STORED on the approved row is a separate decision, below: the
  // validated copy here has already been stripped of any key the tool's
  // Zod schema does not declare (z.object's default "strip" mode), which is
  // correct for a value about to be handed to a domain function that only
  // reads its own declared fields, but wrong for an audit record.
  const effectiveInput = parsedInput.data as Record<string, unknown>;

  // Snapshotted before `apply` runs -- the "before" side of the deep compare
  // `domainCallChanged` needs; reading it after `apply` would just read back
  // whatever `apply` itself did or didn't do. This also means a case that
  // has vanished between staging and approval surfaces as a 404 raised HERE
  // by the audit-trail read, rather than from inside `apply`.
  const caseBeforeApply =
    proposal.caseId !== undefined ? await getCase(context, tenantId, proposal.caseId) : undefined;

  const domainResult = await writeTool.apply!(context, tenantId, effectiveInput, actorEmail);

  const decidedAt = context.now().toISOString();
  const approvedProposal: ProposedChange = {
    ...proposal,
    // NOT `effectiveInput` unconditionally: on a non-edited approval that
    // would silently replace the model's original proposal -- extras
    // included -- with the Zod-stripped copy `apply` was called with (fix-
    // round-2). This is the one subsystem whose entire purpose is recording
    // what happened, so a non-edited approval keeps `proposal.input`
    // byte-identical to what was staged; only a genuine human edit
    // overwrites it, with the validated copy of what the human actually
    // supplied.
    input: editedInput !== undefined ? effectiveInput : proposal.input,
    status: "APPROVED",
    decidedBy: actorEmail,
    decidedAt,
  };
  await putProposal(context, tenantId, approvedProposal);

  const changed = domainCallChanged(caseBeforeApply, domainResult);
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
      // `false` on every pre-Task-10 call site and on every human approval:
      // the flag this function's callers -- Task 11's approve endpoint among
      // them -- would have to go out of their way to set `true`, so the safe
      // reading ("a human approved this") is the one that survives silently.
      autoApplied,
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

  // Unlike the APPROVED side (P42), there is no domain result to take a
  // caseId off of here when `proposal.caseId` is undefined -- a discarded
  // `create_case` proposal never ran `apply`, so no case was ever created to
  // scope an event to. The trace is not lost, though (Minor 6): the
  // discarded proposal itself -- with its `discardReason` -- persists under
  // `proposalPartitionKey` and stays queryable via
  // `proposalStatusGsi1Pk(tenantId, "DISCARDED")`. A future reader (Plan 5's
  // Today screen) that wants rejected proposals in a timeline should read
  // the proposal partition rather than conclude the trace is missing.
  if (proposal.caseId !== undefined) {
    await recordCrmEvent(context, tenantId, proposal.caseId, "PROPOSAL_DISCARDED", actorEmail, {
      proposalId,
      toolName: proposal.toolName,
      reason,
    });
  }
  return discardedProposal;
}
