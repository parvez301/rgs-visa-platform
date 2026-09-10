import type { AppContext } from "../lib/context";
import { badRequest } from "../lib/errors";
import { describeFirstZodIssue } from "../lib/storedRecords";
import { memoryScope, recallMemories } from "../domain/crm/memory";
import {
  AUTO_APPLIABLE_TOOLS,
  HIGH_STAKES_TOOLS,
  applyApprovedChange,
  getProposal,
  stageProposal,
  type ProposedChange,
} from "./approval";
import { readUserPrefs } from "./prefs";
import type { AgentMessage, LlmUsage } from "./providers/types";
import { READ_TOOLS } from "./tools/readTools";
import { ToolRegistry, type ToolKind } from "./tools/registry";
import { WRITE_TOOLS } from "./tools/writeTools";

/**
 * The agent turn loop (spec §7) and the trust ladder that decides, for every
 * write a tool proposes, whether it waits for a human or is applied on the
 * caller's behalf. Every write tool's `execute` only ever proposes
 * (Task 8's approval gate is the only path to a real mutation) -- this is
 * the one place that decides which of the gate's two halves a given
 * proposal gets.
 */

/**
 * Caps a model that never stops calling tools. Without this, a turn against
 * a misbehaving model (or a scripted test with a bug) runs forever and
 * never returns to the caller -- an unattended cost this desk should never
 * pay silently.
 */
export const MAX_TOOL_ITERATIONS = 8;

export interface AgentTurnResult {
  reply: string;
  /** Staged, PENDING-only, awaiting a human. Never includes an entry that already auto-applied -- see `appliedChanges` for those. */
  proposals: ProposedChange[];
  /**
   * Changes applied without staging, at trust level 2. Carries the
   * proposalId so the UI can offer undo -- an auto-applied change the
   * caller cannot name is a change the user cannot take back
   * (task-10-controller-notes.md §2). Every entry's `status` is `APPROVED`;
   * `proposals` above never overlaps with this list.
   */
  appliedChanges: ProposedChange[];
  toolCallsMade: { toolName: string; kind: ToolKind }[];
  usage: LlmUsage;
}

function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function addUsage(runningTotal: LlmUsage, addend: LlmUsage): void {
  runningTotal.inputTokens += addend.inputTokens;
  runningTotal.outputTokens += addend.outputTokens;
  runningTotal.cachedTokens += addend.cachedTokens;
}

/**
 * Role, what the desk has already taught the agent (ORG scope plus the
 * caller's own USER scope -- never another user's, the same restriction
 * `recall`'s tool enforces), and the one behavioural rule every write tool's
 * description already states individually: propose, never touch the table.
 * Read directly through the memory domain module rather than the `recall`
 * tool's `execute`, so this context is available before the model has asked
 * for anything and does not itself count as a tool call.
 */
async function buildSystemPrompt(context: AppContext, tenantId: string, actorEmail: string): Promise<string> {
  const { memories } = await recallMemories(context, tenantId, [
    memoryScope("ORG"),
    memoryScope("USER", actorEmail),
  ]);
  const memorySection =
    memories.length > 0
      ? `What the desk has taught you so far:\n${memories
          .map((memory) => `- (${memory.scope}) ${memory.memoryKey}: ${memory.text}`)
          .join("\n")}`
      : "The desk has not taught you anything yet.";

  return [
    "You are the RGS CRM desk agent. Help the caller work cases, partners and travellers, " +
      "and answer questions using the tools you are given.",
    memorySection,
    "Every write tool only ever proposes a change -- it never touches the database on its own. " +
      "A human still has to approve most proposals; say what you are proposing plainly rather " +
      "than implying it has already happened.",
  ].join("\n\n");
}

function toolResultMessage(toolCallId: string, toolName: string, content: string): AgentMessage {
  // toolName is required on every tool_result, not just toolCallId: the
  // Gemini adapter attributes a function response by tool NAME, not by call
  // id (task-10-controller-notes.md §4, providers/gemini.ts
  // mapMessagesToGemini). One helper builds every tool_result this loop
  // emits so that rule cannot be forgotten at one call site and kept at
  // another.
  return { role: "tool_result", content, toolCallId, toolName };
}

export async function runAgentTurn(
  context: AppContext,
  tenantId: string,
  input: { userMessage: string; conversation: AgentMessage[]; actorEmail: string },
): Promise<AgentTurnResult> {
  const llm = context.llm;
  if (llm === undefined) {
    // Every pre-agent route builds a context with no `llm` at all
    // (lib/context.ts's own doc comment) -- a caller that reaches this
    // function without one is a wiring bug, not a reason to dereference
    // `undefined` and hand the caller a bare TypeError. router.ts maps only
    // ApiError subclasses, so badRequest is what turns this into a legible
    // 400 instead of a 500 (task-10-controller-notes.md §6).
    throw badRequest("This request has no LLM provider configured; the agent cannot run a turn");
  }

  const registry = new ToolRegistry([...READ_TOOLS, ...WRITE_TOOLS]);
  const userPrefs = await readUserPrefs(context, tenantId, input.actorEmail);
  const systemPrompt = await buildSystemPrompt(context, tenantId, input.actorEmail);

  const messages: AgentMessage[] = [...input.conversation, { role: "user", content: input.userMessage }];
  const toolCallsMade: { toolName: string; kind: ToolKind }[] = [];
  const proposals: ProposedChange[] = [];
  const appliedChanges: ProposedChange[] = [];
  const usage = emptyUsage();
  let replyText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const completion = await llm.complete({
      system: systemPrompt,
      messages,
      tools: registry.toolDefinitions(),
    });
    addUsage(usage, completion.usage);
    replyText = completion.text;

    if (completion.toolCalls.length === 0) {
      break;
    }

    // Preserved as history for the next iteration, and pushed
    // UNCONDITIONALLY once the model has called anything -- including when
    // `completion.text` is "" (the common case for a pure tool-calling turn).
    //
    // This message is what carries the calls themselves (`toolCalls`), and
    // every tool_result pushed below answers one of them. Omitting it -- as
    // this loop did until branch review C1 -- left every result in the
    // transcript referring to a call that was never transmitted, which both
    // real providers reject on the next model call: Anthropic requires a
    // `tool_result` block's `tool_use_id` to name a `tool_use` block in the
    // immediately preceding assistant message, and Gemini pairs a
    // `functionResponse` with a `functionCall` part in the preceding model
    // turn. Empty text is not a reason to drop the turn; it is a turn whose
    // whole content is the calls.
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });

    for (const toolCall of completion.toolCalls) {
      const matchedTool = registry.get(toolCall.toolName);
      if (matchedTool === undefined) {
        // An unknown tool name is an ordinary event the model can recover
        // from next turn, not a reason to abort (task-10 brief, step 4.2).
        messages.push(toolResultMessage(toolCall.toolCallId, toolCall.toolName, `Unknown tool "${toolCall.toolName}"`));
        continue;
      }

      // ruling P30 (task-10-controller-notes.md §7): `ToolRegistry.get`
      // guarantees only that `kind` correctly partitions read tools from
      // write tools -- `AgentTool.execute` is checked bivariantly by
      // TypeScript, so nothing at this call site enforces that the model's
      // `input` matches `matchedTool.inputSchema`. This is the one place
      // that guarantee has to come from. `safeParse`, not `parse`: a model
      // producing a malformed argument is an ordinary event it should see
      // and retry, the same rule a throwing tool gets below -- never an
      // exception that ends the turn.
      const parsedInput = matchedTool.inputSchema.safeParse(toolCall.input);
      if (!parsedInput.success) {
        messages.push(
          toolResultMessage(
            toolCall.toolCallId,
            matchedTool.name,
            `Invalid input for tool "${matchedTool.name}": ${describeFirstZodIssue(parsedInput.error)}`,
          ),
        );
        continue;
      }

      // Counted here, after validation passes -- a call that never reached
      // `execute` (unknown tool, or input the schema refused) was never
      // "made" in any sense a caller of this loop would recognise.
      toolCallsMade.push({ toolName: matchedTool.name, kind: matchedTool.kind });

      try {
        if (matchedTool.kind === "read") {
          const readResult = await matchedTool.execute(context, tenantId, parsedInput.data, input.actorEmail);
          messages.push(toolResultMessage(toolCall.toolCallId, matchedTool.name, JSON.stringify(readResult)));
          continue;
        }

        // A write tool's `execute` only ever proposes (Task 8) -- it never
        // touches the table, so reaching this line needs no trust check of
        // its own. What happens to the proposal it returns is the trust
        // ladder's decision, below.
        const proposedChange = (await matchedTool.execute(
          context,
          tenantId,
          parsedInput.data,
          input.actorEmail,
        )) as ProposedChange;

        // Trust ladder (spec §7): level 0 stages every write with full
        // reasoning; level 1 collapses the reasoning shown to the user but
        // still stages; level 2 auto-applies, but only a write that is BOTH
        // on the curated allow-list AND absent from the deny-list, and only
        // for a user who has opted in. `AUTO_APPLIABLE_TOOLS` is checked --
        // not merely "not in HIGH_STAKES_TOOLS" -- because the allow-list is
        // the fail-SAFE default (ruling P46, task-10-controller-notes.md
        // §8): a write tool added later is staged until someone deliberately
        // adds it here, rather than auto-appliable by default because nobody
        // remembered to deny-list it. `!HIGH_STAKES_TOOLS.has(...)` stays as
        // a second, independent check even though Task 8's registry test
        // already proves the two sets disjoint -- belt and suspenders on the
        // one decision in this file that moves money or deletes something
        // with no human in the loop.
        const eligibleForAutoApply =
          userPrefs.trustLevel === 2 &&
          userPrefs.autoApplyOptIn &&
          AUTO_APPLIABLE_TOOLS.has(matchedTool.name) &&
          !HIGH_STAKES_TOOLS.has(matchedTool.name);

        if (eligibleForAutoApply) {
          // Staged first, always -- applyApprovedChange's only way to find
          // a proposal is to read one back that was actually put there
          // (approval.ts's readProposalOrThrow), so "auto-apply" is staging
          // immediately followed by approving, never a shortcut around
          // staging. `autoApplied: true` is what keeps the resulting
          // PROPOSAL_APPROVED event from reading as though a human reviewed
          // it (task-10-controller-notes.md §3) -- `actorEmail` is still who
          // the turn is running for, but nobody actually saw this diff.
          await stageProposal(context, tenantId, proposedChange);
          // A SEPARATE try around only the apply half (fix-round-1 A1 /
          // MAJ-6): `applyApprovedChange` can still throw after staging
          // succeeded. Round 1's fix recorded every such throw as "still
          // PENDING", inferred from the mere fact that something threw --
          // right for a domain-level refusal inside `apply()` itself (e.g.
          // `set_custody` proposing a custody transition its own `execute`
          // never validates: nothing moved, the row really is still
          // PENDING), but exactly backwards for a failure in one of the two
          // writes `applyApprovedChange` makes AFTER `apply()` already
          // succeeded (the approval write, or the audit event) -- there the
          // row is already APPROVED and the case really moved (fix-round-2
          // finding N1: round 1's fix for a dishonest turn result
          // introduced a differently dishonest one). The catch below reads
          // the row back and believes what it says instead of what the
          // catch assumes -- the same lesson
          // `services/migration/src/importCli.ts`'s `tableRecordingWrites`
          // already paid for once (observe whether a write happened; do not
          // deduce it from how far the code got before throwing).
          try {
            await applyApprovedChange(context, tenantId, proposedChange.proposalId, input.actorEmail, undefined, true);
            appliedChanges.push({
              ...proposedChange,
              status: "APPROVED",
              decidedBy: input.actorEmail,
              decidedAt: context.now().toISOString(),
            });
            messages.push(
              toolResultMessage(
                toolCall.toolCallId,
                matchedTool.name,
                `Applied on your behalf (proposalId: ${proposedChange.proposalId}). You can still undo this.`,
              ),
            );
          } catch (applyError) {
            const applyErrorMessage = applyError instanceof Error ? applyError.message : String(applyError);
            // Observed, not inferred: read the row back and classify it by
            // the status the store actually holds. A read-back failure of
            // its own is reported as indeterminate below, naming the
            // proposalId rather than guessing in either direction.
            let observedProposal: ProposedChange | undefined;
            try {
              observedProposal = await getProposal(context, tenantId, proposedChange.proposalId);
            } catch {
              observedProposal = undefined;
            }

            if (observedProposal?.status === "APPROVED") {
              // `apply()` ran and the approval write landed; a write AFTER
              // that point failed (in practice, the audit event). The
              // change is real -- say so, not the opposite.
              appliedChanges.push(observedProposal);
              messages.push(
                toolResultMessage(
                  toolCall.toolCallId,
                  matchedTool.name,
                  `Applied on your behalf (proposalId: ${proposedChange.proposalId}), though recording it hit an ` +
                    `error afterwards (${applyErrorMessage}). You can still undo this.`,
                ),
              );
            } else if (observedProposal?.status === "PENDING") {
              // Nothing moved -- the row this loop staged is still exactly
              // that.
              proposals.push(observedProposal);
              messages.push(
                toolResultMessage(
                  toolCall.toolCallId,
                  matchedTool.name,
                  `Could not apply this automatically (${applyErrorMessage}). Staged for human approval instead ` +
                    `(proposalId: ${proposedChange.proposalId}).`,
                ),
              );
            } else {
              // The read-back itself failed, or the row is in a state this
              // branch cannot explain (DISCARDED, or missing). Do not guess
              // which way this went -- name the id so a human can look it up
              // directly instead of trusting a turn result that might be
              // wrong either way.
              messages.push(
                toolResultMessage(
                  toolCall.toolCallId,
                  matchedTool.name,
                  `Something went wrong applying this (${applyErrorMessage}), and I could not confirm whether it ` +
                    `went through. Please check proposal ${proposedChange.proposalId} directly rather than ` +
                    `assuming either way.`,
                ),
              );
            }
          }
        } else {
          await stageProposal(context, tenantId, proposedChange);
          proposals.push(proposedChange);
          messages.push(
            toolResultMessage(
              toolCall.toolCallId,
              matchedTool.name,
              `Staged for human approval (proposalId: ${proposedChange.proposalId}). Not applied yet.`,
            ),
          );
        }
      } catch (error) {
        // A tool that throws -- a missing case, or one of the tools that
        // refuses an underspecified call outright (search_cases with
        // neither filter, find_traveller with neither input,
        // get_country_checklist for a country with no checklist on file) --
        // must never escape the turn (task-10-controller-notes.md §5). The
        // model sees the failure as an ordinary tool_result and can recover
        // on its next turn, exactly like an unknown tool or a validation
        // failure above.
        const errorMessage = error instanceof Error ? error.message : String(error);
        messages.push(toolResultMessage(toolCall.toolCallId, matchedTool.name, errorMessage));
      }
    }
  }

  return { reply: replyText, proposals, appliedChanges, toolCallsMade, usage };
}
