import { z } from "zod";
import {
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

/** Sentinel for a remember/forget proposal's "from" when no prior memory exists under this key. */
const NO_PRIOR_MEMORY_FROM = "(new memory)";
const FORGOTTEN_MEMORY_TO = "(forgotten)";

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

type RecallToolInput = { scopes: MemoryScopeKind[]; partnerId?: string };

export const recallTool: AgentTool<RecallToolInput> = {
  name: "recall",
  kind: "read",
  description:
    "Recall what the desk has taught you, across the ORG, PARTNER (needs partnerId) and USER " +
    "scopes you name. USER scope always resolves to whoever is asking -- there is no way to read " +
    "another user's memories. The result carries unreadableMemoryKeys: memoryKeys that exist in a " +
    "requested scope but could not be read back -- if it is not empty you MUST say so in your " +
    "answer.",
  inputSchema: z.object({
    scopes: z.array(memoryScopeKindSchema).min(1),
    partnerId: z.string().min(1).optional(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    const resolvedScopes = input.scopes.map((scopeKind) =>
      resolveMemoryScope(scopeKind, input.partnerId, actorEmail),
    );
    return recallMemories(context, tenantId, resolvedScopes);
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
    sourceCaseId: z.string().optional(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    const existingMemory = await getMemoryOrUndefined(context, tenantId, scope, input.memoryKey);
    return proposalFrom(
      context,
      "remember",
      input,
      [{ field: "text", from: existingMemory?.text ?? NO_PRIOR_MEMORY_FROM, to: input.text }],
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
      [{ field: "text", from: existingMemory?.text ?? NO_PRIOR_MEMORY_FROM, to: FORGOTTEN_MEMORY_TO }],
      actorEmail,
    );
  },
  apply: async (context, tenantId, input, actorEmail) => {
    const scope = resolveMemoryScope(input.scope, input.partnerId, actorEmail);
    await forgetMemory(context, tenantId, scope, input.memoryKey, actorEmail);
    return { scope, memoryKey: input.memoryKey, forgotten: true };
  },
};
