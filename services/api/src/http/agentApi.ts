import { z } from "zod";
import type { AppContext } from "../lib/context";
import { forbidden } from "../lib/errors";
import { applyApprovedChange, discardProposal, listPendingProposals } from "../agent/approval";
import { runAgentTurn } from "../agent/loop";
import { recordConfirmedWithoutEdit } from "../agent/prefs";
import {
  MEMORY_SCOPE_KINDS,
  forgetMemory,
  memoryRowExists,
  memoryScope,
  recallMemories,
  rememberMemory,
  type MemoryScopeKind,
} from "../domain/crm/memory";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { Router, parseBody, parseQueryParam, type RequestContext, type RouteHandler } from "./router";
import { requireScreen, requireWrite } from "./adminAccess";

/**
 * Model input billed by the token, arriving over the network, with nothing
 * else in the stack capping it: MAX_TOOL_ITERATIONS (loop.ts) caps how many
 * times one turn calls the model, not how much history is replayed into
 * each call or how long any one message is. The same "unattended cost this
 * desk should never pay silently" reasoning that motivated that cap applies
 * here (task-11-fix-1-review.md m3).
 *
 * This used to be one constant (MAX_TURN_MESSAGE_LENGTH) applied to both
 * `userMessage` and every `conversation` message's `content`. That was
 * wrong for `content`: `content` is not only what a caller typed, it is
 * also what THIS SERVER emitted as `reply` on a previous turn (loop.ts's
 * `replyText = completion.text`, forwarded verbatim, no cap of its own) and
 * that the client is expected to send back as history on the next call. The
 * Anthropic adapter's own completion budget (DEFAULT_MAX_OUTPUT_TOKENS,
 * providers/anthropic.ts) is 4096 tokens -- comfortably north of 8,000
 * characters -- so a maximal reply could not be replayed: the server would
 * emit it at 200, then refuse that same text back at 400 on the very next
 * turn, with the error naming `conversation`, a field the user never typed
 * into (task-11-fix-2-brief.md B2 / NEW-2). The invariant this file must
 * hold is: the server must never emit a reply it will refuse to accept
 * back. So the two limits are separate: `userMessage` keeps the tight
 * inbound cap (it is only ever caller-typed), and `content` gets a limit
 * sized to what the provider can actually produce, with a generous margin
 * against tokenizers whose average is worse than 4 chars/token. Total
 * replay cost is bounded separately, by MAX_TURN_CONVERSATION_TOTAL_LENGTH
 * below, rather than by (message cap × message count) -- which is now far
 * too loose a product to serve as a cost bound on its own.
 */
const MAX_USER_MESSAGE_LENGTH = 8_000;
const MAX_CONVERSATION_MESSAGE_LENGTH = 20_000;
const MAX_TURN_CONVERSATION_MESSAGES = 200;
const MAX_TURN_CONVERSATION_TOTAL_LENGTH = 100_000;
/**
 * A model can call several tools in one turn, but not an unbounded number:
 * MAX_TOOL_ITERATIONS caps iterations, never the width of any one of them,
 * and `toolCalls` arrives from the network like every other body field. The
 * serialized `input` of each call counts toward
 * MAX_TURN_CONVERSATION_TOTAL_LENGTH below for the same reason `content`
 * does -- it is replayed into every model call of the next turn and billed
 * by the token, so leaving it out of the cost bound would reopen the hole
 * that bound exists to close.
 */
const MAX_TOOL_CALLS_PER_MESSAGE = 32;

/**
 * A vendor tool-call id is a short opaque token ("toolu_01ABC...", or a name-
 * and-position string this codebase synthesises for Gemini). This cap exists
 * because the id is replayed verbatim as a `tool_use` block's `id` and billed
 * by the token exactly like the fields around it, and it was the one such
 * field neither capped nor counted (branch-fix re-review N1): a 500,000-char
 * id was accepted at 200 and produced a 500,115-byte request against a
 * declared bound of 100,000.
 */
const MAX_TOOL_CALL_ID_LENGTH = 256;

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
 *
 * `toolCalls` is the same kind of invariant on the other half of the pair
 * (branch review C1). A client replaying `conversation` has to be able to
 * supply the assistant turn that MADE the calls, or the transcript it sends
 * back has tool results answering nothing and both providers refuse the
 * request -- which is precisely the defect the loop was fixed for, walked
 * back in through the route. It is meaningful only on an assistant message,
 * and the refinement below says so rather than letting a caller attach calls
 * to a user turn where neither adapter would map them.
 */
const AgentToolCallBody = z.object({
  toolCallId: z.string().min(1).max(MAX_TOOL_CALL_ID_LENGTH),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
});

const AgentMessageBody = z
  .object({
    role: z.enum(["user", "assistant", "tool_result"]),
    content: z.string().max(MAX_CONVERSATION_MESSAGE_LENGTH),
    toolCalls: z.array(AgentToolCallBody).max(MAX_TOOL_CALLS_PER_MESSAGE).optional(),
    // Belt and suspenders, and knowingly unreachable today: the pairing
    // refinement below forces a tool_result's id to equal one of the
    // preceding assistant turn's call ids, and AgentToolCallBody already caps
    // those -- so no id long enough to trip THIS cap can also pair, and
    // deleting it reddens nothing. Kept anyway, because it stops being
    // redundant the moment the pairing rule is relaxed, and the cost is one
    // line. Same call Task 10 made for the redundant HIGH_STAKES_TOOLS check.
    toolCallId: z.string().max(MAX_TOOL_CALL_ID_LENGTH).optional(),
    toolName: z.string().optional(),
  })
  .refine((message) => message.role !== "tool_result" || message.toolName !== undefined, {
    message: "a tool_result message must carry toolName",
  })
  .refine((message) => message.toolCalls === undefined || message.role === "assistant", {
    message: "only an assistant message may carry toolCalls",
  })
  // branch-fix re-review N5, and the last member of N2's family: an assistant
  // turn with neither text nor calls maps to an empty content block, which
  // both vendors refuse. The loop cannot build one -- it pushes an assistant
  // turn only once the model has called something -- so this is reachable
  // only from a replayed transcript, and belongs with the rest of the
  // client-supplied malformations refused here as a 400.
  .refine(
    (message) =>
      message.role !== "assistant" || message.content !== "" || (message.toolCalls ?? []).length > 0,
    { message: "an assistant message must carry text, tool calls, or both" },
  );

/**
 * What one replayed message costs to send to the model again: its text, plus
 * the serialized arguments of any tool calls it carries. See
 * MAX_TOOL_CALLS_PER_MESSAGE above.
 */
function replayedMessageLength(message: z.infer<typeof AgentMessageBody>): number {
  const toolCallsLength = (message.toolCalls ?? []).reduce(
    (runningTotal, toolCall) =>
      runningTotal +
      toolCall.toolCallId.length +
      toolCall.toolName.length +
      JSON.stringify(toolCall.input).length,
    0,
  );
  // A tool_result's own toolCallId is replayed as the `tool_use_id` of the
  // block it becomes, so it is billed for the same reason the call side is.
  return message.content.length + toolCallsLength + (message.toolCallId?.length ?? 0);
}

export const RunTurnBody = z
  .object({
    userMessage: z.string().trim().min(1).max(MAX_USER_MESSAGE_LENGTH),
    conversation: z.array(AgentMessageBody).max(MAX_TURN_CONVERSATION_MESSAGES).optional(),
  })
  .superRefine((body, context) => {
    // branch-fix re-review N2: the round that let a client supply the
    // assistant turn did not check that it did. A replayed transcript whose
    // tool_result names no transmitted call is byte for byte the malformation
    // C1 exists to prevent, arriving from the client instead of from the loop
    // -- so it is refused here as an ordinary 400, for exactly the reason the
    // toolName refinement above gives: better than an opaque provider error
    // mid-turn. This is the rule test/pairingWalkers.ts encodes, applied to
    // the transcript before it can reach a mapper.
    //
    // A RUN of tool_result messages all answer the same assistant turn, so the
    // set is carried across them and reset by any other message.
    let callIdsFromPrecedingAssistantTurn: Set<string> | undefined;
    (body.conversation ?? []).forEach((message, messageIndex) => {
      if (message.role !== "tool_result") {
        callIdsFromPrecedingAssistantTurn =
          message.role === "assistant"
            ? new Set((message.toolCalls ?? []).map((toolCall) => toolCall.toolCallId))
            : undefined;
        return;
      }
      if (message.toolCallId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversation", messageIndex, "toolCallId"],
          message: "a tool_result message must carry toolCallId, naming the call it answers",
        });
        return;
      }
      if (callIdsFromPrecedingAssistantTurn === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversation", messageIndex],
          message:
            "a tool_result must immediately follow the assistant message that made the call it answers",
        });
        return;
      }
      if (!callIdsFromPrecedingAssistantTurn.has(message.toolCallId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversation", messageIndex, "toolCallId"],
          message: `tool_result names toolCallId "${message.toolCallId}", which the preceding assistant message does not carry`,
        });
      }
    });

    const totalConversationLength = (body.conversation ?? []).reduce(
      (runningTotal, message) => runningTotal + replayedMessageLength(message),
      0,
    );
    if (totalConversationLength > MAX_TURN_CONVERSATION_TOTAL_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conversation"],
        message: `total conversation content length ${totalConversationLength} exceeds ${MAX_TURN_CONVERSATION_TOTAL_LENGTH}`,
      });
    }
  });

const ApproveProposalBody = z.object({
  // Deliberately no actorEmail/approvedBy field: the actor is always the
  // verified caller from the route access gate (task-11-controller-notes.md §1), and
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
 * requireWrite guarantees `callerId` and CRM write access are present, but
 * router.ts still defaults a missing `email` JWT claim to `""`, and createCase/createPartner/
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
 * inside the shared access helpers -- changing them would break the Plan
 * 2/3 behaviour above, which is deliberately the opposite.
 */
function requireAdminEmail(requestContext: RequestContext): string {
  const { adminEmail } = requireWrite(requestContext, "crm");
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
 * The seven routes `registerAgentRoutes` builds the router from, and the
 * source `AGENT_ROUTES` (derived, exported below) is generated from. This is
 * the fix for task-11-fix-1-review.md C1 -- before this, every test built its
 * own bare `new Router()`, so the whole table could be dropped from
 * `buildAdminRouter` (adminApi.ts) with the suite fully green. A test that
 * walks `AGENT_ROUTES` through the real `buildAdminRouter` now has no way to
 * miss a route that this task's table intends to expose, and no way to
 * silently lose one that is removed from here.
 *
 * What this array does NOT guarantee (task-11-fix-2-brief.md A1/M4, after
 * this overstatement was caught reddening 0 tests): nothing stops a *ninth*
 * route from being registered directly on the `Router` passed into
 * `registerAgentRoutes` below -- `router.add` stays public, and this array
 * only constrains routes that choose to be listed in it. `AGENT_ROUTES` is
 * the right thing to dispatch tests through (it names what THIS task's
 * table intends to expose); it is the wrong thing to drive an "is every
 * registered route authenticated" test from -- that test has to walk
 * `Router.registeredRoutes`, the router's own account of what `add` was
 * actually called with, not a declaration of it.
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
      requireScreen(requestContext, "crm");
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
      const approvalResult = await applyApprovedChange(
        context,
        DEFAULT_TENANT_ID,
        requestContext.pathParams["proposalId"]!,
        adminEmail,
        body.editedInput,
      );

      // The ladder-advancement signal, finally recorded (branch review I4).
      // `confirmedWithoutEditCount` was added to the shared schema in this
      // branch specifically to be it, and nothing wrote it -- so Plan 5 would
      // have inherited a counter permanently at 0 and a "propose advancing
      // this user" screen with nothing to propose from.
      //
      // Only when the human changed NOTHING: an approval carrying an edit is
      // evidence the agent got it wrong, which is the opposite of the signal
      // this counter stands for. Counting is not the same act as raising
      // trust, and `recordConfirmedWithoutEdit` never touches `trustLevel` or
      // `autoApplyOptIn` -- advancement stays opt-in and never silent
      // (task-10-controller-notes.md §6).
      //
      // Awaited unguarded, after the change is applied: the same exposure
      // `recordCrmEvent` already has inside applyApprovedChange -- a failure
      // here answers 500 for a change that did happen. Swallowing it would
      // make the counter quietly lossy, which is worse for the one thing it
      // exists to be evidence for.
      if (body.editedInput === undefined) {
        await recordConfirmedWithoutEdit(context, DEFAULT_TENANT_ID, adminEmail);
      }

      return approvalResult;
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
      const { adminEmail } = requireScreen(requestContext, "crm");
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
      const { adminEmail } = requireWrite(requestContext, "crm");
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
      const { adminEmail } = requireWrite(requestContext, "crm");
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
      //
      // `memoryRowExists`, not `getMemoryOrUndefined` (task-11-fix-2-brief.md
      // NEW-1): the latter throws CorruptRecordError on a row that will not
      // parse, which made a corrupt row 409 here with the row left standing
      // -- undeletable through this API, the one thing an operator most
      // needs to do with it. A raw existence check never throws, and
      // `forgetMemory`'s own `table.delete` never parses either, so a
      // corrupt row deletes exactly as cleanly as a healthy one.
      const existingMemory = await memoryRowExists(context, DEFAULT_TENANT_ID, scope, memoryKey);
      await forgetMemory(context, DEFAULT_TENANT_ID, scope, memoryKey, adminEmail);
      return { forgotten: existingMemory };
    },
  },
];

/**
 * The (method, path) pairs this task's route table intends to expose,
 * derived from `AGENT_ROUTE_DEFINITIONS` rather than maintained separately.
 * Exported so a test can dispatch every one of them through the real
 * `buildAdminRouter(context)` (closing task-11-fix-1-review.md C1). Do NOT
 * use this to enumerate "every route that requires admin" -- see the
 * comment on `AGENT_ROUTE_DEFINITIONS` above and `Router.registeredRoutes`
 * (router.ts) for why that property needs the router's own registry, not
 * this array.
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
