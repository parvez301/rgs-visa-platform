import type { CrmEventView } from "../api/crmClient";
import { describeCrmEvent } from "./eventCopy";

interface TimelineProps {
  /** Oldest first, exactly as `GET /cases/{caseId}/events` returns them. */
  events: CrmEventView[];
}

/**
 * The shape shared by every entry. Split from the two variants below so the
 * ONLY difference between a human entry's class list and an auto-applied
 * one's is the variant -- `Timeline.test.tsx` asserts the two differ, and a
 * difference that came from anything but the variant would make that
 * assertion pass while proving nothing.
 */
const TIMELINE_ENTRY_BASE_CLASS = "flex flex-col gap-0.5 rounded-xl px-4 py-3 text-sm";

const HUMAN_TIMELINE_ENTRY_CLASS = `${TIMELINE_ENTRY_BASE_CLASS} border border-line bg-paper`;

/**
 * Deliberately not a tint away from the human entry: a dashed rule and a
 * marker, the same visual vocabulary `Chip.tsx` uses for import debt, because
 * both say the same thing -- a value nobody chose by hand.
 */
const AUTO_APPLIED_TIMELINE_ENTRY_CLASS = `${TIMELINE_ENTRY_BASE_CLASS} border border-dashed border-amber-400 bg-amber-50/60`;

const eventTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The stored ISO string is what a reader can quote back; the formatted local
 * time is what they can act on. An unparseable timestamp falls back to the raw
 * string rather than rendering "Invalid Date".
 */
function formatEventTimestamp(createdAt: string): string {
  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(createdAtDate.getTime())) return createdAt;
  return eventTimestampFormatter.format(createdAtDate);
}

/**
 * The case's audit surface (spec §5). Pure: it takes events, it never fetches
 * them, so it is testable with a literal array and `CasePage` owns the query.
 *
 * Order is the API's own -- `listCaseEvents` queries the case partition on the
 * `EVENT#<ts>#<id>` sort key, which comes back ascending -- and this component
 * does not re-sort it. A timeline that reversed it silently would put every
 * effect above its cause.
 */
export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        Nothing has happened on this case yet.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {events.map((event) => {
        const { title, detail, isAutoApplied } = describeCrmEvent(event);
        return (
          <li
            key={event.eventId}
            data-testid="timeline-entry"
            className={isAutoApplied ? AUTO_APPLIED_TIMELINE_ENTRY_CLASS : HUMAN_TIMELINE_ENTRY_CLASS}
          >
            <div className="flex flex-wrap items-center gap-2">
              <time dateTime={event.createdAt} className="text-xs text-ink-soft">
                {formatEventTimestamp(event.createdAt)}
              </time>
              {isAutoApplied && (
                <span
                  data-testid="timeline-auto-applied-marker"
                  className="rounded-full border border-dashed border-amber-500 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold leading-none text-amber-900"
                >
                  Auto-applied
                </span>
              )}
            </div>
            <p data-testid="timeline-entry-title" className="font-semibold text-ink">
              {title}
            </p>
            {detail !== "" && <p className="text-ink-soft">{detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
