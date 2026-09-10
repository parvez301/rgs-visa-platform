import { z } from "zod";
import type { AppContext } from "../lib/context";
import { forbidden } from "../lib/errors";
import { applyApprovedChange, discardProposal, listPendingProposals } from "../agent/approval";
import { runAgentTurn } from "../agent/loop";
import {
  MEMORY_SCOPE_KINDS,
  forgetMemory,
  getMemoryOrUndefined,
  memoryScope,
  recallMemories,
  rememberMemory,
  type MemoryScopeKind,
} from "../domain/crm/memory";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { Router, parseBody, parseQueryParam, type RequestContext, type RouteHandler } from "./router";
import { requireAdmin } from "./adminApi";

/**
 * Model input billed by the token, arriving over the network, with nothing
 * else in the stack capping it: MAX_TOOL_ITERATIONS (loop.ts) caps how many
 * times one turn calls the model, not how much history is replayed into
 * each call or how long any one message is. The same "unattended cost this
 * desk should never pay silently" reasoning that motivated that cap applies
 * here (task-11-fix-1-review.md m3).
 */
const MAX_TURN_MESSAGE_LENGTH = 8_000;
const MAX_TURN_CONVERSATION_MESSAGES = 200;

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
    content: z.string().max(MAX_TURN_MESSAGE_LENGTH),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .refine((message) => message.role !== "tool_result" || message.toolName !== undefined, {
    message: "a tool_result message must carry toolName",
  });

const RunTurnBody = z.object({
  userMessage: z.string().trim().min(1).max(MAX_TURN_MESSAGE_LENGTH),
  conversation: z.array(AgentMessageBody).max(MAX_TURN_CONVERSATION_MESSAGES).optional(),
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
 * §2) and that an admin HTTP route must not reopen. No competing field
 * (`userEmail`, `scopeKey`, `email`, ...) is ever read from the request for
 * this purpose -- `callerEmail` is the only input this function accepts for
 * identity, on purpose (task-11-fix-1-review.md C2).
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
 * requireAdmin only guarantees `callerId` is present -- router.ts defaults a
 * missing `email` JWT claim to `""`, and createCase/createPartner/
 * rememberMemory all tolerate that by OMITTING the author rather than
 * refusing the request (cases.ts:85, partners.ts:60, memory.ts's own doc
 * comment on `createdByEmail`) -- correct for them, and pinned by
 * partners.test.ts's "omits createdByEmail for an admin token that carries
 * no email claim". Creating a record anonymously is tolerable.
 *
 * Approving or discarding a proposal is not the same act: `decidedBy` is
 * the audit trail that tells a human's decision apart from an auto-applied
 * one (ruling P25), and an empty string there is indistinguishable from
 * "nobody decided this" -- the same defect class as recording the WRONG
 * person, which is exactly what controller-notes §1 exists to prevent. The
 * turn route belongs in this group too: it stages proposals under
 * `proposedBy`, the same kind of audit field.
 *
 * Refused HERE, at the three routes that record an actor, rather than
 * inside `requireAdmin` itself -- changing it there would break the Plan
 * 2/3 behaviour above, which is deliberately the opposite.
 */
function requireAdminEmail(requestContext: RequestContext): string {
  const { adminEmail } = requireAdmin(requestContext);
  if (adminEmail === "") {
    throw forbidden(
      "This admin token has no email claim, so it cannot be recorded as the actor for this action",
    );
  }
  return adminEmail;
}

interface AgentRouteDefinition {
  method: string;
  path: string;
  buildHandler: (context: AppContext) => RouteHandler;
}

/**
 * The seven routes, and nothing else registers them: `registerAgentRoutes`
 * below builds the router FROM this array, so a route cannot exist without
 * appearing in it, and `AGENT_ROUTES` (derived, exported below) cannot omit
 * one either. This is the fix for task-11-fix-1-review.md C1/M4 -- before
 * this, every test built its own bare `new Router()`, so the whole table
 * could be dropped from `buildAdminRouter` (adminApi.ts) with the suite
 * fully green. A test that walks `AGENT_ROUTES` through the real
 * `buildAdminRouter` now has no way to miss a route that exists, and no way
 * to silently lose one that is removed from here.
 */
const AGENT_ROUTE_DEFINITIONS: AgentRouteDefinition[] = [
  {
    method: "POST",
    path: "/api/v1/admin/crm/agent/turn",
    buildHandler: (context) => async (requestContext) => {
      const adminEmail = requireAdminEmail(requestContext);
      const body = parseBody(RunTurnBody, requestContext.body);
      // context.llm undefined is handled by runAgentTurn itself, which
      // answers badRequest (400) rather than dereferencing undefined
      // (task-11-controller-notes.md §5) -- nothing here needs to repeat
      // that check.
      return runAgentTurn(context, DEFAULT_TENANT_ID, {
        userMessage: body.userMessage,
        conversation: body.conversation ?? [],
        actorEmail: adminEmail,
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/admin/crm/agent/proposals",
    buildHandler: (context) => async (requestContext) => {
      requireAdmin(requestContext);
      // { proposals, unreadableProposalIds } -- a row that would not parse
      // is named in the response rather than silently missing from it, the
      // same rule every other listing in this codebase follows.
      return listPendingProposals(context, DEFAULT_TENANT_ID);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/admin/crm/agent/proposals/{proposalId}/approve",
    buildHandler: (context) => async (requestContext) => {
      const adminEmail = requireAdminEmail(requestContext);
      const body = parseBody(ApproveProposalBody, requestContext.body);
      // A human clicking Approve, never the trust ladder's own auto-apply
      // path -- autoApplied stays at applyApprovedChange's default of
      // false, so PROPOSAL_APPROVED events from this route are
      // distinguishable from Task 10's auto-applied ones (ruling P25).
      return applyApprovedChange(
        context,
        DEFAULT_TENANT_ID,
        requestContext.pathParams["proposalId"]!,
        adminEmail,
        body.editedInput,
      );
    },
  },
  {
    method: "PUT",
    path: "/api/v1/admin/crm/agent/proposals/{proposalId}/discard",
    buildHandler: (context) => async (requestContext) => {
      const adminEmail = requireAdminEmail(requestContext);
      const body = parseBody(DiscardProposalBody, requestContext.body);
      return discardProposal(
        context,
        DEFAULT_TENANT_ID,
        requestContext.pathParams["proposalId"]!,
        adminEmail,
        body.reason,
      );
    },
  },
  {
    method: "GET",
    path: "/api/v1/admin/crm/agent/memories",
    buildHandler: (context) => async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const scopeKind = parseQueryParam(
        MemoryScopeKindSchema,
        "scope",
        requestContext.queryParams["scope"],
      );
      const scope = resolveAdminMemoryScope(scopeKind, requestContext.queryParams["partnerId"], adminEmail);
      return recallMemories(context, DEFAULT_TENANT_ID, [scope]);
    },
  },
  {
    method: "POST",
    path: "/api/v1/admin/crm/agent/memories",
    buildHandler: (context) => async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const body = parseBody(RememberMemoryBody, requestContext.body);
      const scope = resolveAdminMemoryScope(body.scope, body.partnerId, adminEmail);
      return rememberMemory(
        context,
        DEFAULT_TENANT_ID,
        {
          scope,
          memoryKey: body.memoryKey,
          text: body.text,
          ...(body.sourceCaseId !== undefined ? { sourceCaseId: body.sourceCaseId } : {}),
        },
        // A person typing this straight into the admin screen, never the
        // agent's own `remember` tool (memoryTools.ts passes "agent").
        // rememberMemory's provenance refinement requires sourceCaseId only
        // for an "agent" author, so a human can file an org-wide policy
        // note with no case to cite it against (task-11-fix-1-review.md,
        // Group D).
        "human",
        adminEmail,
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/crm/agent/memories/{memoryKey}",
    buildHandler: (context) => async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      const scopeKind = parseQueryParam(
        MemoryScopeKindSchema,
        "scope",
        requestContext.queryParams["scope"],
      );
      const scope = resolveAdminMemoryScope(scopeKind, requestContext.queryParams["partnerId"], adminEmail);
      const memoryKey = requestContext.pathParams["memoryKey"]!;
      // forgetMemory is deliberately idempotent (memory.ts) -- correct, but
      // the response must say what actually happened rather than claim a
      // deletion that changed nothing (task-11-fix-1-review.md m2; the same
      // honesty memoryTools.ts's NOTHING_TO_FORGET_FROM sentinel exists for
      // on the approval card). Read before delete, not after: forgetMemory
      // would report "gone" either way once it has run.
      const existingMemory = await getMemoryOrUndefined(context, DEFAULT_TENANT_ID, scope, memoryKey);
      await forgetMemory(context, DEFAULT_TENANT_ID, scope, memoryKey, adminEmail);
      return { forgotten: existingMemory !== undefined };
    },
  },
];

/**
 * The (method, path) pairs actually registered, derived from
 * `AGENT_ROUTE_DEFINITIONS` rather than maintained separately -- an eighth
 * route has to join that array to exist at all, and joining it means
 * joining this list too. Exported so a test can dispatch every one of them
 * through the real `buildAdminRouter(context)` (closing
 * task-11-fix-1-review.md C1) and confirm every one of them requires admin
 * (closing M4), with no hand-maintained enumeration to fall out of sync.
 */
export const AGENT_ROUTES: { method: string; path: string }[] = AGENT_ROUTE_DEFINITIONS.map(
  ({ method, path }) => ({ method, path }),
);

/**
 * Mounted onto the admin router, so these inherit the admin Cognito
 * authorizer and the existing /api/v1/admin/{proxy+} API Gateway route -- no
 * CDK change (task-11-controller-notes.md §4). PUT, never PATCH: PATCH is
 * not among the routed admin methods.
 */
export function registerAgentRoutes(router: Router, context: AppContext): Router {
  for (const { method, path, buildHandler } of AGENT_ROUTE_DEFINITIONS) {
    router.add(method, path, buildHandler(context));
  }
  return router;
}
