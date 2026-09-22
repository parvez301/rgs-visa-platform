import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { AdminShell } from "../components/AdminShell";
import { useAgentPanelSession } from "./agent/AgentPanelProvider";
import { PRIMARY_BUTTON_CLASS } from "./components/controls";

const MIN_AGENT_PANEL_WIDTH = 300;
const MAX_AGENT_PANEL_WIDTH = 560;
const DEFAULT_AGENT_PANEL_WIDTH = 380;

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
 * The CRM screen's chrome: the admin header above a capped-width
 * `[main | agent panel]` grid, split by a draggable vertical rule.
 *
 * Spec §6: resizable, collapsible, NEVER a modal. Nothing here sets
 * `role="dialog"`, `aria-modal` or `inert`, and the main column stays fully
 * interactive whatever the panel is doing.
 *
 * Width is `wide` (~1440px), not full-bleed: ultrawide full-width stretched
 * the Ledger into thin cells and a sparse filter bar. The panel starts CLOSED
 * and is opened from a floating button pinned to the bottom-right corner of
 * the viewport (the owner's placement, 2026-09-16). Open/closed lives in
 * `AgentPanelProvider`, above the routes, so a panel opened on the Ledger is
 * still open on the case a desk agent clicks through to. The button is always
 * on screen, so the panel can never become unreachable.
 */
export function CrmLayout({ children, agentPanel }: CrmLayoutProps) {
  const { isPanelOpen, setPanelOpen } = useAgentPanelSession();
  const [agentPanelWidth, setAgentPanelWidth] = useState(DEFAULT_AGENT_PANEL_WIDTH);
  const isDraggingSplitterRef = useRef(false);

  function beginDraggingSplitter(pointerDownEvent: PointerEvent<HTMLDivElement>) {
    isDraggingSplitterRef.current = true;
    pointerDownEvent.currentTarget.setPointerCapture(pointerDownEvent.pointerId);
  }

  function dragSplitter(pointerMoveEvent: PointerEvent<HTMLDivElement>) {
    if (!isDraggingSplitterRef.current) return;
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
    <AdminShell contentWidth="wide">
      <div
        className="crm-root relative grid h-[calc(100vh-112px)] min-h-[480px]"
        style={{
          gridTemplateColumns: isPanelOpen ? `minmax(0, 1fr) 12px ${agentPanelWidth}px` : "minmax(0, 1fr)",
        }}
      >
        <div className="min-w-0 overflow-hidden">{children}</div>
        {isPanelOpen && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the agent panel"
              className="group flex cursor-col-resize items-stretch justify-center"
              onPointerDown={beginDraggingSplitter}
              onPointerMove={dragSplitter}
              onPointerUp={stopDraggingSplitter}
            >
              <div className="w-px bg-line group-hover:bg-ink/30" />
            </div>
            <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-paper">
              {agentPanel}
            </aside>
          </>
        )}
      </div>
      {/*
        Fixed to the viewport, not to the grid: it must stay put while the
        Ledger scrolls, and it must stay reachable when the column it controls
        is not rendered at all. `UndoToast` stacks at bottom-LEFT so the two
        never overlap.
      */}
      <button
        type="button"
        onClick={() => setPanelOpen(!isPanelOpen)}
        aria-expanded={isPanelOpen}
        aria-label={isPanelOpen ? "Hide the agent panel" : "Show the agent panel"}
        className={`${PRIMARY_BUTTON_CLASS} fixed bottom-6 right-6 z-40 px-5 py-2.5 shadow-lg shadow-rgs-red/30`}
      >
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-white/90" />
        {isPanelOpen ? "Close agent" : "Agent"}
      </button>
    </AdminShell>
  );
}
