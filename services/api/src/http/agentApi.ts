import { z } from "zod";
import type { AppContext } from "../lib/context";
import { applyApprovedChange, discardProposal, listPendingProposals } from "../agent/approval";
import { runAgentTurn } from "../agent/loop";
import {
  MEMORY_SCOPE_KINDS,
  forgetMemory,
  memoryScope,
  recallMemories,
  rememberMemory,
  type MemoryScopeKind,
} from "../domain/crm/memory";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { Router, parseBody, parseQueryParam } from "./router";
import { requireAdmin } from "./adminApi";

/**
 * Mirrors AgentMessage (agent/providers/types.ts) exactly. A route accepting
 * prior conversation from the client is accepting untrusted input like any
 * other body field (task-11-controller-notes.md "two things carried
 * forward") -- parsed here, not trusted structurally. The refinement below
 * enforces the one invariant the loop itself only guarantees for messages it
 * builds (loop.ts's own toolResultMessage comment, carried from Task 10's
 * MIN-6): the Gemini adapter attributes a tool result by name, not by call
 * id, and throws without one, so a client-supplied tool_result with no
 * toolName would reach the model as a message it cannot use. Refused here as
 * an ordinary 400 instead of surfacing as an opaque provider error mid-turn.
 */
const AgentMessageBody = z
  .object({
    role: z.enum(["user", "assistant", "tool_result"]),
    content: z.string(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .refine((message) => message.role !== "tool_result" || message.toolName !== undefined, {
    message: "a tool_result message must carry toolName",
  });

const RunTurnBody = z.object({
  userMessage: z.string().trim().min(1),
  conversation: z.array(AgentMessageBody).optional(),
});

const ApproveProposalBody = z.object({
  // Deliberately no actorEmail/approvedBy field: the actor is always the
  // verified caller from requireAdmin (task-11-controller-notes.md §1), and
  // Zod's default "strip" mode on z.object drops any such field a caller
  // sends anyway, before it ever reaches this handler.
  editedInput: z.record(z.unknown()).optional(),
});

const DiscardProposalBody = z.object({
  reason: z.string().trim().min(1),
});

const MemoryScopeKindSchema = z.enum(MEMORY_SCOPE_KINDS);

const RememberMemoryBody = z.object({
  scope: MemoryScopeKindSchema,
  partnerId: z.string().min(1).optional(),
  memoryKey: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
  sourceCaseId: z.string().min(1).optional(),
});

/**
 * Turns the scope kind a caller named (plus partnerId, for PARTNER) into the
 * composite scope string the memory table partitions on -- the HTTP-layer
 * twin of memoryTools.ts's own (private) resolveMemoryScope. USER always
 * resolves through the VERIFIED admin caller's identity, never a query
 * string or body field: there is deliberately no way for this route to name
 * another user's USER scope, the same restriction the agent's own recall/
 * remember/forget tools enforce by construction (task-9-controller-notes.md
 * §2) and that an admin HTTP route must not reopen.
 */
function resolveAdminMemoryScope(
  scopeKind: MemoryScopeKind,
  partnerId: string | undefined,
  callerEmail: string,
): string {
  if (scopeKind === "USER") return memoryScope("USER", callerEmail);
  // memoryScope("PARTNER", ...) itself throws badRequest when the key is
  // missing or empty -- reused rather than duplicated here, so "PARTNER
  // scope needs a partnerId" stays defined in exactly one place.
  if (scopeKind === "PARTNER") return memoryScope("PARTNER", partnerId ?? "");
  return memoryScope("ORG");
}

/**
 * Mounted onto the admin router, so these inherit the admin Cognito
 * authorizer and the existing /api/v1/admin/{proxy+} API Gateway route -- no
 * CDK change (task-11-controller-notes.md §4). PUT, never PATCH: PATCH is
 * not among the routed admin methods.
 */
export function registerAgentRoutes(router: Router, context: AppContext): Router {
  const tenantId = DEFAULT_TENANT_ID;

  return router
    .add("POST", "/api/v1/admin/crm/agent/turn", async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const body = parseBody(RunTurnBody, requestContext.body);
      // context.llm undefined is handled by runAgentTurn itself, which
      // answers badRequest (400) rather than dereferencing undefined
      // (task-11-controller-notes.md §5) -- nothing here needs to repeat
      // that check.
      return runAgentTurn(context, tenantId, {
        userMessage: body.userMessage,
        conversation: body.conversation ?? [],
        actorEmail: adminEmail,
      });
    })
    .add("GET", "/api/v1/admin/crm/agent/proposals", async (requestContext) => {
      requireAdmin(requestContext);
      // { proposals, unreadableProposalIds } -- a row that would not parse
      // is named in the response rather than silently missing from it, the
      // same rule every other listing in this codebase follows.
      return listPendingProposals(context, tenantId);
    })
    .add(
      "PUT",
      "/api/v1/admin/crm/agent/proposals/{proposalId}/approve",
      async (requestContext) => {
        const { adminEmail } = requireAdmin(requestContext);
        const body = parseBody(ApproveProposalBody, requestContext.body);
        // A human clicking Approve, never the trust ladder's own auto-apply
        // path -- autoApplied stays at applyApprovedChange's default of
        // false, so PROPOSAL_APPROVED events from this route are
        // distinguishable from Task 10's auto-applied ones (ruling P25).
        return applyApprovedChange(
          context,
          tenantId,
          requestContext.pathParams["proposalId"]!,
          adminEmail,
          body.editedInput,
        );
      },
    )
    .add(
      "PUT",
      "/api/v1/admin/crm/agent/proposals/{proposalId}/discard",
      async (requestContext) => {
        const { adminEmail } = requireAdmin(requestContext);
        const body = parseBody(DiscardProposalBody, requestContext.body);
        return discardProposal(
          context,
          tenantId,
          requestContext.pathParams["proposalId"]!,
          adminEmail,
          body.reason,
        );
      },
    )
    .add("GET", "/api/v1/admin/crm/agent/memories", async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const scopeKind = parseQueryParam(
        MemoryScopeKindSchema,
        "scope",
        requestContext.queryParams["scope"],
      );
      const scope = resolveAdminMemoryScope(scopeKind, requestContext.queryParams["partnerId"], adminEmail);
      return recallMemories(context, tenantId, [scope]);
    })
    .add("POST", "/api/v1/admin/crm/agent/memories", async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const body = parseBody(RememberMemoryBody, requestContext.body);
      const scope = resolveAdminMemoryScope(body.scope, body.partnerId, adminEmail);
      return rememberMemory(
        context,
        tenantId,
        {
          scope,
          memoryKey: body.memoryKey,
          text: body.text,
          ...(body.sourceCaseId !== undefined ? { sourceCaseId: body.sourceCaseId } : {}),
        },
        adminEmail,
      );
    })
    .add(
      "DELETE",
      "/api/v1/admin/crm/agent/memories/{memoryId}",
      async (requestContext) => {
        const { adminEmail } = requireAdmin(requestContext);
        const scopeKind = parseQueryParam(
          MemoryScopeKindSchema,
          "scope",
          requestContext.queryParams["scope"],
        );
        const scope = resolveAdminMemoryScope(scopeKind, requestContext.queryParams["partnerId"], adminEmail);
        // The path segment is named memoryId to match the brief's route
        // table; a memory's actual identifying field within its scope is
        // memoryKey (domain/crm/memory.ts) -- there is no separate id.
        await forgetMemory(context, tenantId, scope, requestContext.pathParams["memoryId"]!, adminEmail);
        return { forgotten: true };
      },
    );
}
