import { useState } from "react";
import { crm } from "@rgs/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { crmClient, type AgentTurnResponse, type ProposalView } from "../api/crmClient";
import { crmQueryKeys, useMemories, useProposals } from "../api/hooks";
import { LEDGER_CACHE_KEY_PREFIX } from "../api/mutations";
import { MemoryCitations } from "./MemoryCitations";
import {
  ProposalCard,
  appliedChangeFrom,
  readSingleAxisReversal,
  type AppliedChange,
} from "./ProposalCard";
import { useAgentPanelSession } from "./AgentPanelProvider";
import { describeIterationCap } from "./transcript";

/**
 * `ToolKind` ("read" | "write", tools/registry.ts) as the words a sentence
 * about a tool call uses. A kind this build has never heard of falls through
 * to the raw value rather than rendering blank -- the same bargain
 * `describeEnumValue` strikes for every other enum that arrives as a string.
 */
const AGENT_TOOL_KIND_LABELS: Record<string, string> = {
  read: "looked something up",
  write: "proposed a change",
};

function describeRequestFailure(requestError: unknown, fallbackMessage: string): string {
  if (requestError instanceof Error && requestError.message.length > 0) return requestError.message;
  return fallbackMessage;
}

/**
 * A memory's stored `scope` is a COMPOSITE -- "ORG", "PARTNER#<id>",
 * "USER#<email>" (domain/crm/keys.ts) -- but `forgetMemory` takes the KIND and
 * an optional partnerId, because the route resolves USER through the verified
 * caller and never a field from the request. Split on the FIRST separator
 * only: an email local part may legally contain one.
 */
function splitMemoryScope(storedScope: string): {
  scopeKind: "ORG" | "PARTNER" | "USER";
  partnerId: string | undefined;
} {
  const separatorIndex = storedScope.indexOf("#");
  const scopeKind = separatorIndex === -1 ? storedScope : storedScope.slice(0, separatorIndex);
  const scopeKey = separatorIndex === -1 ? undefined : storedScope.slice(separatorIndex + 1);
  if (scopeKind === "PARTNER") return { scopeKind: "PARTNER", partnerId: scopeKey };
  if (scopeKind === "USER") return { scopeKind: "USER", partnerId: undefined };
  return { scopeKind: "ORG", partnerId: undefined };
}

export interface AgentPanelProps {
  /**
   * The Ledger's current row selection, or the one case a Case screen is
   * showing (R62). Lifted in as a prop rather than read from a context: there
   * is exactly one producer per screen and a context would be a second way to
   * be wrong about which.
   */
  selectedCaseIds?: string[];
  /**
   * A turn result to render when the session has none of its own yet. The
   * panel never invents one; this is how a screen (or a test) seeds the
   * surface with the last thing that happened.
   */
  initialResult?: AgentTurnResponse;
}

const PANEL_CONTROL_CLASS =
  "rounded-crm-control border border-crm-rule-box bg-crm-canvas px-2 py-1 text-[13px] text-crm-charcoal disabled:opacity-60";

/**
 * The persistent agent surface in `CrmLayout`'s right column (spec §6).
 *
 * Never a modal, never a takeover: it is a column beside the Ledger, and the
 * Ledger stays fully interactive while it is open. `--crm-primary` does not
 * appear in this file at all -- the single purple control in the product is
 * Approve, inside `ProposalCard`.
 */
export function AgentPanel({ selectedCaseIds = [], initialResult }: AgentPanelProps) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const session = useAgentPanelSession();

  const [draftMessage, setDraftMessage] = useState("");
  const [forgettingMemoryKeys, setForgettingMemoryKeys] = useState<string[]>([]);
  const [memoryFailureMessage, setMemoryFailureMessage] = useState<string | undefined>(undefined);

  const proposalsQuery = useProposals();
  const orgMemoriesQuery = useMemories("ORG");
  const userMemoriesQuery = useMemories("USER");

  const pendingProposals: ProposalView[] = proposalsQuery.data?.proposals ?? [];
  const unreadableProposalIds: string[] = proposalsQuery.data?.unreadableProposalIds ?? [];
  const rememberedFacts: crm.CrmMemory[] = [
    ...(orgMemoriesQuery.data?.memories ?? []),
    ...(userMemoriesQuery.data?.memories ?? []),
  ];
  const unreadableMemoryKeys: string[] = [
    ...(orgMemoriesQuery.data?.unreadableMemoryKeys ?? []),
    ...(userMemoriesQuery.data?.unreadableMemoryKeys ?? []),
  ];

  function invalidateMemoryLists(): void {
    void queryClient.invalidateQueries({ queryKey: crmQueryKeys.memories("ORG", undefined) });
    void queryClient.invalidateQueries({ queryKey: crmQueryKeys.memories("USER", undefined) });
  }

  function invalidateAfterApproval(caseId: string | undefined): void {
    void queryClient.invalidateQueries({ queryKey: crmQueryKeys.proposals() });
    // An approved write mutates a case, so the two caches holding cases have
    // to be refetched exactly as a direct human edit would refetch them.
    void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
    if (caseId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseId) });
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseId) });
    }
  }

  /**
   * R72: what the turn applied on its own, in the order the turns happened.
   * At trust level 2 the loop writes without staging anything, so these never
   * pass through the pending list -- but spec §6 promises an undo on every
   * applied change, and the panel used to read this field only to decide
   * whether to invalidate a cache.
   */
  const autoAppliedChanges: AppliedChange[] = session.turns.flatMap((turn) =>
    (turn.result?.appliedChanges ?? []).map((appliedProposal) =>
      appliedChangeFrom(appliedProposal, appliedProposal.input, true),
    ),
  );

  async function runTurn(): Promise<void> {
    const userMessage = draftMessage.trim();
    if (userMessage === "" || idToken === null || session.isTurnInFlight) return;
    setDraftMessage("");
    const turnId = session.beginTurn(userMessage);
    try {
      // `conversation` is the replay and NEVER contains `userMessage`: the
      // route takes the two separately, and sending the pending turn in both
      // replays it to the model twice.
      const result = await crmClient.runAgentTurn(idToken, {
        userMessage,
        conversation: session.transcript,
      });
      session.completeTurn(turnId, userMessage, result);
      // A turn can stage proposals and (at trust level 2) apply changes.
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.proposals() });
      if (result.appliedChanges.length > 0) {
        void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
      }
    } catch (turnError) {
      session.failTurn(turnId, describeRequestFailure(turnError, "The turn could not be completed."));
    }
  }

  async function approveProposal(
    proposalId: string,
    editedInput?: Record<string, unknown>,
  ): Promise<unknown> {
    if (idToken === null) throw new Error("You are signed out, so this cannot be approved.");
    const approvalResult = await crmClient.approveProposal(idToken, proposalId, editedInput);
    const approvedProposal = pendingProposals.find((proposal) => proposal.proposalId === proposalId);
    if (approvedProposal !== undefined) invalidateAfterApproval(approvedProposal.caseId);
    return approvalResult;
  }

  async function discardProposal(proposalId: string, reason: string): Promise<unknown> {
    if (idToken === null) throw new Error("You are signed out, so this cannot be discarded.");
    const discardResult = await crmClient.discardProposal(idToken, proposalId, reason);
    void queryClient.invalidateQueries({ queryKey: crmQueryKeys.proposals() });
    return discardResult;
  }

  /**
   * There is no un-approve route. What this does is what a desk agent would do
   * by hand: move the one axis the proposal changed back through the case's
   * own REST route, and only when the state machine allows that edge --
   * `readSingleAxisReversal` returns `undefined` otherwise, and the card then
   * says the change cannot be undone from here instead of offering a button.
   */
  async function undoApproval(appliedChange: AppliedChange): Promise<unknown> {
    if (idToken === null) throw new Error("You are signed out, so this cannot be undone.");
    const reversal = readSingleAxisReversal(appliedChange);
    if (reversal === undefined) {
      throw new Error("This change has no reverse move, so it cannot be undone from here.");
    }
    const reversalResult =
      reversal.axis === "custody"
        ? await crmClient.setCustody(idToken, reversal.caseId, reversal.applicantRef, reversal.toCustody)
        : await crmClient.setBillingStatus(idToken, reversal.caseId, reversal.toBillingStatus);
    invalidateAfterApproval(appliedChange.caseId);
    return reversalResult;
  }

  async function forgetMemory(memory: crm.CrmMemory): Promise<void> {
    if (idToken === null) return;
    const { scopeKind, partnerId } = splitMemoryScope(memory.scope);
    setMemoryFailureMessage(undefined);
    setForgettingMemoryKeys((currentKeys) => [...currentKeys, memory.memoryKey]);
    try {
      await crmClient.forgetMemory(idToken, memory.memoryKey, scopeKind, partnerId);
      invalidateMemoryLists();
    } catch (forgetError) {
      setMemoryFailureMessage(
        describeRequestFailure(forgetError, "That fact could not be forgotten."),
      );
    } finally {
      setForgettingMemoryKeys((currentKeys) =>
        currentKeys.filter((memoryKey) => memoryKey !== memory.memoryKey),
      );
    }
  }

  const seededResult = session.turns.length === 0 ? initialResult : undefined;

  return (
    <aside
      aria-label="Agent"
      className="crm-root flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-[14px] leading-[1.45]"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-[13px] font-medium text-crm-charcoal">Agent</h2>
        {/*
          Truthful, and static on purpose: nothing in production writes
          `CrmUserPrefs`, so every user is at trustLevel 0 with autoApplyOptIn
          false, and there is no admin route to read the record back. A live
          indicator would be a number this build cannot obtain, dressed up as
          one it had.
        */}
        <p className="text-[12px] text-crm-steel">
          Trust level 0 · auto-apply is off, so every change waits for you.
        </p>
        <p className="text-[12px] text-crm-steel">{describeSelection(selectedCaseIds)}</p>
      </header>

      <ol className="flex flex-col gap-3">
        {session.turns.map((turn) => (
          <li key={turn.turnId} className="flex flex-col gap-1">
            <p className="rounded-crm-badge bg-crm-surface px-2 py-1 text-[13px] text-crm-charcoal">
              {turn.userMessage}
            </p>
            {turn.status === "pending" && <p className="text-[13px] text-crm-steel">Thinking…</p>}
            {turn.result !== undefined && turn.result.reply.trim() !== "" && (
              <p className="px-2 text-[13px] text-crm-charcoal">{turn.result.reply}</p>
            )}
            {turn.result?.stoppedAtIterationCap === true && (
              <p role="status" className="px-2 text-[13px] text-crm-steel">
                {describeIterationCap()}
              </p>
            )}
            {turn.status === "failed" && (
              // Never a bare error: the message that failed is still above it,
              // and the tools the agent had used this session are named below,
              // so a desk agent can see how far it got.
              <p role="alert" className="px-2 text-[13px] text-crm-charcoal">
                This turn did not finish: {turn.failureMessage}
              </p>
            )}
          </li>
        ))}
      </ol>

      {seededResult?.stoppedAtIterationCap === true && (
        <p role="status" className="text-[13px] text-crm-steel">
          {describeIterationCap()}
        </p>
      )}

      {session.toolNamesUsed.length > 0 && (
        <section aria-label="What the agent has done this session" className="text-[13px]">
          <h3 className="font-medium text-crm-charcoal">What the agent has done this session</h3>
          <ul className="mt-1 flex flex-col gap-0.5">
            {session.toolNamesUsed.map((toolName) => (
              <li key={toolName} className="flex flex-wrap items-center gap-1.5 text-crm-steel">
                <code className="rounded-crm-chip bg-crm-surface px-1 text-[12px] text-crm-charcoal">
                  {toolName}
                </code>
                <span>{describeToolKinds(session, toolName)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unreadableProposalIds.length > 0 && (
        <p role="status" className="text-[13px] text-crm-steel">
          {unreadableProposalIds.length === 1
            ? "1 proposal could not be read and is missing from this list."
            : `${unreadableProposalIds.length} proposals could not be read and are missing from this list.`}
        </p>
      )}

      <ProposalCard
        proposals={pendingProposals}
        autoAppliedChanges={autoAppliedChanges}
        onApprove={approveProposal}
        onDiscard={discardProposal}
        onUndoApproval={undoApproval}
      />

      <MemoryCitations
        memories={rememberedFacts}
        unreadableMemoryKeys={unreadableMemoryKeys}
        isLoading={orgMemoriesQuery.isLoading || userMemoriesQuery.isLoading}
        onForget={(memory) => void forgetMemory(memory)}
        forgettingMemoryKeys={forgettingMemoryKeys}
        failureMessage={memoryFailureMessage}
      />

      <form
        className="mt-auto flex flex-col gap-2"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void runTurn();
        }}
      >
        <label className="flex flex-col gap-1 text-[13px] text-crm-steel">
          Ask the agent
          <textarea
            value={draftMessage}
            onChange={(changeEvent) => setDraftMessage(changeEvent.target.value)}
            rows={3}
            className="rounded-crm-control border border-crm-rule-box bg-crm-canvas px-2 py-1 text-[13px] text-crm-charcoal"
          />
        </label>
        <button
          type="submit"
          disabled={draftMessage.trim() === "" || session.isTurnInFlight}
          className={`w-fit self-end ${PANEL_CONTROL_CLASS}`}
        >
          {session.isTurnInFlight ? "Sending…" : "Send"}
        </button>
      </form>
    </aside>
  );
}

function describeSelection(selectedCaseIds: string[]): string {
  if (selectedCaseIds.length === 0) return "No cases selected.";
  if (selectedCaseIds.length === 1) return "1 case selected.";
  return `${selectedCaseIds.length} cases selected.`;
}

function describeToolKinds(
  session: { turns: { result?: AgentTurnResponse }[] },
  toolName: string,
): string {
  const kinds = new Set<string>();
  for (const turn of session.turns) {
    for (const toolCallMade of turn.result?.toolCallsMade ?? []) {
      if (toolCallMade.toolName === toolName) kinds.add(toolCallMade.kind);
    }
  }
  return [...kinds].map((kind) => AGENT_TOOL_KIND_LABELS[kind] ?? kind).join(" and ");
}
