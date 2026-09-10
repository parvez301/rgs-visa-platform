import { z } from "zod";
import {
  MEMORY_RECALL_PAGE_LIMIT,
  MEMORY_SCOPE_KINDS,
  forgetMemory,
  getMemoryOrUndefined,
  memoryScope,
  recallMemories,
  rememberMemory,
  type MemoryScopeKind,
} from "../../domain/crm/memory";
import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { newId } from "../../lib/ids";
import type { ProposedChange } from "../approval";
import type { AgentTool } from "./registry";

const memoryScopeKindSchema = z.enum(MEMORY_SCOPE_KINDS);

/** Sentinel for a remember proposal's "from" when no prior memory exists under this key. */
const NO_PRIOR_MEMORY_FROM = "(new memory)";
const FORGOTTEN_MEMORY_TO = "(forgotten)";
/**
 * Forget's own "from" sentinel for a memoryKey nothing occupies -- distinct
 * from NO_PRIOR_MEMORY_FROM, which paired with a "to" of real text reads as
 * a creation. Pairing NO_PRIOR_MEMORY_FROM with FORGOTTEN_MEMORY_TO instead
 * rendered "(new memory) -> (forgotten)", which reads as though something
 * were being created and then immediately destroyed -- misleading on an
 * approval card for a call that in fact changes nothing.
 */
const NOTHING_TO_FORGET_FROM = "(nothing remembered)";
/**
 * `sourceCaseId`'s own "from"/"to" sentinels on the approval card (fix round
 * 2, item 2) -- distinct from NO_PRIOR_MEMORY_FROM (which describes the TEXT
 * field having no prior value) even though the wording is similar, because a
 * re-remember can carry a prior memory (a real "from" text) while still
 * having no prior sourceCaseId to show, or vice versa; the two fields are
 * independent and must not share a sentinel that would make one look like
 * the other's echo.
 */
const NO_PRIOR_SOURCE_CASE_ID = "(none)";
/** What a proposal with no sourceCaseId shows for "to" -- rememberMemory
 * rejects this at apply time (an agent-created memory must cite a case), but
 * the card must say so plainly rather than leaving the field blank. */
const MISSING_SOURCE_CASE_ID_TO = "(none -- will be rejected on apply)";

/**
 * Mints the two generated fields every proposal needs and assembles the
 * rest into a complete ProposedChange. The memory-tool twin of
 * writeTools.ts's identically-shaped, identically-named helper -- not
 * imported from there, because writeTools.ts registers this file's tools
 * into WRITE_TOOLS, and importing back the other way would cycle. Memory
 * proposals never carry a caseId of their own.
 */
function proposalFrom(
  context: AppContext,
  toolName: string,
  input: Record<string, unknown>,
  summary: ProposedChange["summary"],
  proposedBy: string,
): ProposedChange {
  return {
    proposalId: newId("prop", context.now().getTime()),
    toolName,
    input,
    summary,
    proposedBy,
    proposedAt: context.now().toISOString(),
    status: "PENDING",
  };
}

/**
 * Turns the scope kind the model named (plus partnerId, for PARTNER) into
 * the composite scope string the memory table partitions on. USER always
 * resolves through the CALLING actorEmail -- never through tool input --
 * or a model that can pass an email could read, write, or delete another
 * desk user's private notes by asking for them (task-9-controller-notes.md
 * §2). There is deliberately no field anywhere in these tools' input
 * schemas that could carry another user's identity for USER scope.
 *
 * `execute` calls this with the proposer's identity, only to look up a
 * value for the diff it shows the approver. `apply` calls it again with the
 * approver's identity, and that second call is the one that reaches
 * storage -- so a USER-scope remember/forget always lands under whoever
 * actually applies it, never under a name either side merely typed.
 *
 * That re-derivation is a deliberate, pinned choice (see
 * "the acting identity" tests in memory.test.ts) with a real cost, not only
 * a benefit: threading the PROPOSER's identity through to `apply` instead
 * would mean widening `AgentTool.apply`'s signature (and the gate that
 * calls it) across all seven write tools, to serve a role this product does
 * not have yet -- a distinct approver acting on someone else's behalf. The
 * accepted cost until that role exists: in a split propose/approve flow, a
 * USER-scope memory lands under the APPROVER, not the person who asked for
 * it, so a staff member's private note approved by a supervisor is filed
 * under the supervisor and the staff member never gets it back from
 * `recall`. A second, related consequence: `execute` (above call site)
 * builds the approval card's diff from the PROPOSER's own scope, while
 * `apply` (below call site) writes under the APPROVER's -- so in a split
 * flow the card's "from" value describes a different row than the one the
 * write actually lands on.
 */
function resolveMemoryScope(
  scopeKind: MemoryScopeKind,
  partnerId: string | undefined,
  actorEmail: string,
): string {
  if (scopeKind === "PARTNER") {
    if (partnerId === undefined) {
      throw badRequest("PARTNER scope needs a partnerId");
    }
    return memoryScope("PARTNER", partnerId);
  }
  if (scopeKind === "USER") {
    return memoryScope("USER", actorEmail);
  }
  return memoryScope("ORG");
}

type RecallToolInput = { scopes: MemoryScopeKind[]; partnerId?: string; limit?: number };

export const recallTool: AgentTool<RecallToolInput> = {
  name: "recall",
  kind: "read",
  description:
    "Recall what the desk has taught you, across the ORG, PARTNER (needs partnerId) and USER " +
    `scopes you name. Returns at most ${MEMORY_RECALL_PAGE_LIMIT} per named scope. USER scope ` +
    "always resolves to whoever is asking -- there is no way to read another user's memories. " +
    "The result carries unreadableMemoryKeys: memoryKeys that exist in a requested scope but " +
    "could not be read back -- if it is not empty you MUST say so in your answer.",
  inputSchema: z.object({
    scopes: z.array(memoryScopeKindSchema).min(1),
    partnerId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MEMORY_RECALL_PAGE_LIMIT).optional(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    const resolvedScopes = input.scopes.map((scopeKind) =>
      resolveMemoryScope(scopeKind, input.partnerId, actorEmail),
    );
    return recallMemories(context, tenantId, resolvedScopes, input.limit ?? MEMORY_RECALL_PAGE_LIMIT);
  },
};

type RememberToolInput = {
  scope: MemoryScopeKind;
  partnerId?: string;
  memoryKey: string;
  text: string;
  sourceCaseId?: string;
};

export const rememberTool: AgentTool<RememberToolInput> = {
  name: "remember",
  kind: "write",
  description:
    "Propose remembering a fact the desk has taught you, at ORG, PARTNER (needs partnerId) or " +
    "USER (always your own identity, never another user's) scope. Staged for human approval -- " +
    "this never writes on its own. Re-remembering the same memoryKey updates that memory in place " +
    "instead of creating a near-duplicate. Cite the case you learned this from in sourceCaseId -- " +
    "a memory with no source case is rejected when the proposal is applied, not here.",
  inputSchema: z.object({
    scope: memoryScopeKindSchema,
    partnerId: z.string().min(1).optional(),
    memoryKey: z.string().min(1),
    text: z.string().trim().min(1).max(2000),
    // .min(1), not a bare .optional() (fix round 2, item 1): an empty string
    // is not a case id, and letting one past the schema only to have
    // rememberMemory's readCaseOrThrow refuse it later would trade a clear
    // 400 at the boundary for a less legible 404 from a domain lookup that
    // was never going to find anything.
    sourceCaseId: z.string().min(1).optional(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    const existingMemory = await getMemoryOrUndefined(context, tenantId, scope, input.memoryKey);
    return proposalFrom(
      context,
      "remember",
      input,
      [
        // The scope KIND, not the composite: house style puts the target in
        // the field name (set_custody's `applicants.${ref}.custody`,
        // writeTools.ts), and an ORG-scope and a USER-scope remember of the
        // same text must not render as the same card. The composite is
        // approver-derived (resolveMemoryScope's doc comment above) and
        // genuinely unknowable at propose time in a split flow, so the kind
        // -- always known here -- is what the field name can honestly show.
        {
          field: `${input.scope}/${input.memoryKey}`,
          from: existingMemory?.text ?? NO_PRIOR_MEMORY_FROM,
          to: input.text,
        },
        // The other half of M3 (fix round 2, item 2): an approver confirming
        // a remember could not previously see which case's timeline they
        // were about to stamp. rememberMemory now REFUSES a sourceCaseId
        // naming no real case (fix round 2, item 1), but it cannot catch one
        // naming a real, unrelated case -- only a human who recognizes the
        // case can, and only if the card shows it.
        {
          field: "sourceCaseId",
          from: existingMemory?.sourceCaseId ?? NO_PRIOR_SOURCE_CASE_ID,
          to: input.sourceCaseId ?? MISSING_SOURCE_CASE_ID_TO,
        },
      ],
      actorEmail,
    );
  },
  apply: async (context, tenantId, input, actorEmail) => {
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    return rememberMemory(
      context,
      tenantId,
      {
        scope,
        memoryKey: input.memoryKey,
        text: input.text,
        ...(input.sourceCaseId !== undefined ? { sourceCaseId: input.sourceCaseId } : {}),
      },
      actorEmail,
    );
  },
};

type ForgetToolInput = { scope: MemoryScopeKind; partnerId?: string; memoryKey: string };

export const forgetTool: AgentTool<ForgetToolInput> = {
  name: "forget",
  kind: "write",
  description:
    "Propose forgetting (deleting) a memory at ORG, PARTNER (needs partnerId) or USER (always " +
    "your own identity, never another user's) scope. Staged for human approval -- this never " +
    "deletes on its own.",
  inputSchema: z.object({
    scope: memoryScopeKindSchema,
    partnerId: z.string().min(1).optional(),
    memoryKey: z.string().min(1),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    const existingMemory = await getMemoryOrUndefined(context, tenantId, scope, input.memoryKey);
    return proposalFrom(
      context,
      "forget",
      input,
      // Same field-naming rule as remember, above: the scope KIND, not the
      // composite.
      [
        {
          field: `${input.scope}/${input.memoryKey}`,
          from: existingMemory?.text ?? NOTHING_TO_FORGET_FROM,
          to: FORGOTTEN_MEMORY_TO,
        },
      ],
      actorEmail,
    );
  },
  apply: async (context, tenantId, input, actorEmail) => {
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    await forgetMemory(context, tenantId, scope, input.memoryKey, actorEmail);
    return { scope, memoryKey: input.memoryKey, forgotten: true };
  },
};
