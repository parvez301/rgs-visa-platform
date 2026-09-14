import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { AdminShell } from "../components/AdminShell";
import "./theme.css";

const MIN_AGENT_PANEL_WIDTH = 280;
const MAX_AGENT_PANEL_WIDTH = 560;
const DEFAULT_AGENT_PANEL_WIDTH = 360;

interface CrmLayoutProps {
  children: ReactNode;
}

/**
 * The CRM screen's own chrome: the visa-platform header from `AdminShell`
 * above a two-column `[main | agent panel]` grid, split by a draggable
 * vertical rule.
 *
 * The agent panel itself is Task 15's deliverable. Until then the right
 * column carries a placeholder plus the trust indicator spec §12 asks every
 * screen with an agent surface to show, so the two-column shape -- and the
 * space the real panel will occupy -- exists from the day the Ledger ships.
 */
export function CrmLayout({ children }: CrmLayoutProps) {
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
    <AdminShell>
      <div
        className="crm-root grid h-[calc(100vh-160px)] min-h-[480px]"
        style={{ gridTemplateColumns: `minmax(0, 1fr) 6px ${agentPanelWidth}px` }}
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
        <div className="flex flex-col gap-3 overflow-y-auto border-l border-crm-rule-box p-4">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-crm-badge bg-crm-surface px-2 py-1 text-[12px] text-crm-steel">
            <span aria-hidden="true">●</span> Agent panel arrives in a later task
          </span>
          <p className="text-[13px] text-crm-steel">
            Every change the agent proposes will show up here for approval before it touches a
            case.
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
