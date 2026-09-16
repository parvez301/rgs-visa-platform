import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { AdminShell } from "../components/AdminShell";

const MIN_AGENT_PANEL_WIDTH = 280;
const MAX_AGENT_PANEL_WIDTH = 560;
const DEFAULT_AGENT_PANEL_WIDTH = 360;

interface CrmLayoutProps {
  children: ReactNode;
  /**
   * The agent surface for the right column (R62). Passed in by each screen --
   * `LedgerPage` with the grid's current selection, `CasePage` with the one
   * case it is showing -- rather than mounted here, because only the screen
   * knows what the agent should inherit.
   */
  agentPanel: ReactNode;
}

/**
 * The CRM screen's own chrome: the visa-platform header from `AdminShell`
 * above a two-column `[main | agent panel]` grid, split by a draggable
 * vertical rule.
 *
 * Spec §6: resizable, collapsible, NEVER a modal. Nothing here sets
 * `role="dialog"`, `aria-modal` or `inert`, and the main column stays fully
 * interactive whatever the panel is doing -- a desk agent working a case must
 * never have to dismiss the agent to keep working.
 *
 * Collapse is React state rather than a stored preference: the toggle stays
 * reachable while collapsed (it moves into the splitter rail), so the panel
 * can never become unreachable, and nothing about the Ledger changes when it
 * is away.
 */
export function CrmLayout({ children, agentPanel }: CrmLayoutProps) {
  const [agentPanelWidth, setAgentPanelWidth] = useState(DEFAULT_AGENT_PANEL_WIDTH);
  const [isAgentPanelCollapsed, setIsAgentPanelCollapsed] = useState(false);
  const isDraggingSplitterRef = useRef(false);

  function beginDraggingSplitter(pointerDownEvent: PointerEvent<HTMLDivElement>) {
    isDraggingSplitterRef.current = true;
    pointerDownEvent.currentTarget.setPointerCapture(pointerDownEvent.pointerId);
  }

  function dragSplitter(pointerMoveEvent: PointerEvent<HTMLDivElement>) {
    if (!isDraggingSplitterRef.current || isAgentPanelCollapsed) return;
    const layoutRightEdge = pointerMoveEvent.currentTarget.parentElement?.getBoundingClientRect().right ?? 0;
    const proposedAgentPanelWidth = layoutRightEdge - pointerMoveEvent.clientX;
    setAgentPanelWidth(
      Math.min(MAX_AGENT_PANEL_WIDTH, Math.max(MIN_AGENT_PANEL_WIDTH, proposedAgentPanelWidth)),
    );
  }

  function stopDraggingSplitter(pointerUpEvent: PointerEvent<HTMLDivElement>) {
    isDraggingSplitterRef.current = false;
    pointerUpEvent.currentTarget.releasePointerCapture(pointerUpEvent.pointerId);
  }

  return (
    <AdminShell>
      <div
        className="crm-root relative grid h-[calc(100vh-160px)] min-h-[480px]"
        style={{
          gridTemplateColumns: isAgentPanelCollapsed
            ? "minmax(0, 1fr) 6px 0px"
            : `minmax(0, 1fr) 6px ${agentPanelWidth}px`,
        }}
      >
        <div className="min-w-0 overflow-hidden">{children}</div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the agent panel"
          className="cursor-col-resize bg-crm-rule-box hover:bg-crm-steel"
          onPointerDown={beginDraggingSplitter}
          onPointerMove={dragSplitter}
          onPointerUp={stopDraggingSplitter}
        />
        <div className="flex min-h-0 flex-col overflow-hidden border-l border-crm-rule-box">
          {!isAgentPanelCollapsed && agentPanel}
        </div>
        {/*
          Absolutely positioned against the grid, deliberately NOT a child of
          the splitter: a button inside the drag handle receives the same
          pointerdown that starts a resize, so every click on it began a drag
          it never meant to start. Out of flow means it stays put -- and stays
          reachable by keyboard -- when the column itself is 0 wide.
        */}
        <button
          type="button"
          onClick={() => setIsAgentPanelCollapsed((wasCollapsed) => !wasCollapsed)}
          aria-expanded={!isAgentPanelCollapsed}
          className="absolute right-2 top-1 z-10 rounded-crm-control border border-crm-rule-box bg-crm-canvas px-1.5 py-0.5 text-[12px] text-crm-steel"
        >
          {isAgentPanelCollapsed ? "Show the agent panel" : "Hide the agent panel"}
        </button>
      </div>
    </AdminShell>
  );
}
