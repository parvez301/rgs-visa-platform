import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AgentTurnResponse } from "../api/crmClient";
import { appendTurnResult, type TranscriptMessage } from "./transcript";

/**
 * One exchange as the panel RENDERS it -- not as the route replays it.
 *
 * The two are deliberately different objects. `transcript` below is the narrow
 * user/assistant text replay the turn route validates (see `transcript.ts`);
 * this is everything a human wants to see about the same exchange, including
 * the things that must never be replayed: which tools ran, whether the loop
 * ran out of iterations, and -- for a turn that never came back -- what the
 * failure was.
 */
export interface AgentTurnEntry {
  turnId: string;
  userMessage: string;
  status: "pending" | "answered" | "failed";
  result?: AgentTurnResponse;
  failureMessage?: string;
}

export interface AgentPanelSession {
  /** Exactly what goes back to the route as `conversation`. */
  transcript: TranscriptMessage[];
  turns: AgentTurnEntry[];
  lastResult: AgentTurnResponse | undefined;
  /** Every tool the agent has used this session, oldest first, deduplicated. */
  toolNamesUsed: string[];
  isTurnInFlight: boolean;
  beginTurn(userMessage: string): string;
  completeTurn(turnId: string, userMessage: string, result: AgentTurnResponse): void;
  failTurn(turnId: string, failureMessage: string): void;
}

const AgentPanelContext = createContext<AgentPanelSession | null>(null);

let nextTurnSequenceNumber = 0;

/**
 * R63. `CrmLayout` is rendered per page, so a panel that owned its own
 * conversation would lose it on every REF click -- the desk agent walks from
 * the Ledger to a case and the agent has forgotten the question they were
 * halfway through. This provider is mounted ONCE, in `main.tsx`, above the
 * routes; `AgentPanel` reads it through `useAgentPanelSession`.
 *
 * State only. Every request the panel makes still belongs to the panel (and to
 * react-query's cache), because a request in a provider this high up would
 * outlive the screen that started it with nothing on screen to report it.
 */
export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const sessionValue = useAgentPanelSessionState();
  return <AgentPanelContext.Provider value={sessionValue}>{children}</AgentPanelContext.Provider>;
}

/**
 * The session's state machinery, extracted from the provider so that "the
 * panel owns this itself" is a one-line change -- which is what makes R63's
 * navigation test able to fail. Called in exactly one place: the provider.
 */
function useAgentPanelSessionState(): AgentPanelSession {
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [turns, setTurns] = useState<AgentTurnEntry[]>([]);

  const beginTurn = useCallback((userMessage: string): string => {
    const turnId = `agent-turn-${nextTurnSequenceNumber++}`;
    // Rendered immediately and NOT added to `transcript`: the request carries
    // this message as `userMessage`, separately from `conversation`, and a
    // panel that put it in both would replay it to the model twice.
    setTurns((currentTurns) => [...currentTurns, { turnId, userMessage, status: "pending" }]);
    return turnId;
  }, []);

  const completeTurn = useCallback(
    (turnId: string, userMessage: string, result: AgentTurnResponse) => {
      setTranscript((currentTranscript) => appendTurnResult(currentTranscript, userMessage, result));
      setTurns((currentTurns) =>
        currentTurns.map((turn) =>
          turn.turnId === turnId ? { ...turn, status: "answered", result } : turn,
        ),
      );
    },
    [],
  );

  const failTurn = useCallback((turnId: string, failureMessage: string) => {
    // The transcript is deliberately NOT touched: a turn the route refused
    // produced no assistant reply, and recording the user turn alone would
    // replay a question the model never saw an answer to. The entry stays on
    // screen as a failure so the human can retype or retry.
    setTurns((currentTurns) =>
      currentTurns.map((turn) =>
        turn.turnId === turnId ? { ...turn, status: "failed", failureMessage } : turn,
      ),
    );
  }, []);

  const sessionValue = useMemo<AgentPanelSession>(() => {
    const answeredTurns = turns.filter((turn) => turn.result !== undefined);
    const toolNamesUsed: string[] = [];
    for (const turn of answeredTurns) {
      for (const toolCallMade of turn.result?.toolCallsMade ?? []) {
        if (!toolNamesUsed.includes(toolCallMade.toolName)) toolNamesUsed.push(toolCallMade.toolName);
      }
    }
    return {
      transcript,
      turns,
      lastResult: answeredTurns.at(-1)?.result,
      toolNamesUsed,
      isTurnInFlight: turns.some((turn) => turn.status === "pending"),
      beginTurn,
      completeTurn,
      failTurn,
    };
  }, [transcript, turns, beginTurn, completeTurn, failTurn]);

  return sessionValue;
}

/**
 * Throws rather than falling back to component-local state. A silent fallback
 * would compile, render, and lose the conversation on every navigation -- the
 * exact defect R63 exists to prevent, made invisible. Same bargain
 * `useUndoToast` strikes.
 */
export function useAgentPanelSession(): AgentPanelSession {
  const session = useContext(AgentPanelContext);
  if (session === null) {
    throw new Error("useAgentPanelSession must be called beneath an AgentPanelProvider");
  }
  return session;
}
