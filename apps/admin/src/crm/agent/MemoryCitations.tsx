import type { crm } from "@rgs/shared";
import { MEMORY_AUTHOR_LABELS, describeEnumValue, describeMemoryScope } from "../labels";

export interface MemoryCitationsProps {
  memories: crm.CrmMemory[];
  unreadableMemoryKeys: string[];
  isLoading: boolean;
  onForget(memory: crm.CrmMemory): void;
  forgettingMemoryKeys: string[];
  failureMessage: string | undefined;
}

/**
 * What the agent has been taught, and a way to take any of it back on the spot
 * (spec §6, "Memory in Motion").
 *
 * R58 -- and the one sentence in this component that is load-bearing. The turn
 * response carries NO per-turn citation list: `AgentTurnResult` is `reply`,
 * `proposals`, `appliedChanges`, `toolCallsMade`, `stoppedAtIterationCap` and
 * `usage`, and nothing else. So this list cannot honestly say "the agent used
 * these on this turn". What it CAN say, and what is exactly true, is that
 * `runAgentTurn` injects every ORG memory and every memory in the caller's own
 * USER scope into the system prompt of every model call it makes
 * (loop.ts:84-86) -- so these are the facts the agent is working from, all the
 * time. The heading says that, in those words.
 *
 * When the API grows a real citation list, the data source here changes and
 * the shape does not.
 */
export function MemoryCitations({
  memories,
  unreadableMemoryKeys,
  isLoading,
  onForget,
  forgettingMemoryKeys,
  failureMessage,
}: MemoryCitationsProps) {
  return (
    <section aria-label="What the agent remembers" className="text-[13px]">
      <h3 className="font-medium text-crm-charcoal">What the agent remembers</h3>
      <p className="mt-0.5 text-crm-steel">
        The agent is given these on every turn. Delete one and it stops seeing it.
      </p>

      {isLoading && <p className="mt-1 text-crm-steel">Loading what the agent remembers…</p>}

      {!isLoading && memories.length === 0 && (
        <p className="mt-1 text-crm-steel">The desk has not taught the agent anything yet.</p>
      )}

      {failureMessage !== undefined && (
        <p role="alert" className="mt-1 text-crm-charcoal">
          {failureMessage}
        </p>
      )}

      <ul className="mt-2 flex flex-col gap-1.5">
        {memories.map((memory) => (
          <li
            key={`${memory.scope}#${memory.memoryKey}`}
            className="flex items-start gap-2 rounded-crm-badge border border-crm-rule-row px-2 py-1"
          >
            <span className="flex-1">
              <span className="block text-crm-charcoal">{memory.text}</span>
              <span className="block text-[12px] text-crm-steel">
                Remembered by {describeEnumValue(memory.createdBy, MEMORY_AUTHOR_LABELS)} for{" "}
                {describeMemoryScope(memory.scope)}
              </span>
            </span>
            <button
              type="button"
              // Named, never a bare "×": a delete control whose only label is a
              // glyph tells a screen reader nothing about WHICH fact it forgets.
              aria-label={`Forget ${memory.memoryKey}`}
              disabled={forgettingMemoryKeys.includes(memory.memoryKey)}
              onClick={() => onForget(memory)}
              className="shrink-0 rounded-crm-control border border-crm-rule-box px-1.5 text-crm-steel disabled:opacity-60"
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>

      {unreadableMemoryKeys.length > 0 && (
        // Named, never silently missing -- the rule every listing in this
        // codebase follows.
        <p role="status" className="mt-1 text-crm-steel">
          {unreadableMemoryKeys.length === 1
            ? "1 remembered fact could not be read and is missing from this list."
            : `${unreadableMemoryKeys.length} remembered facts could not be read and are missing from this list.`}
        </p>
      )}
    </section>
  );
}
