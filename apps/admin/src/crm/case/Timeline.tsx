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
const TIMELINE_ENTRY_BASE_CLASS =
  "flex flex-col gap-0.5 rounded-crm-card px-3 py-2 text-[14px] leading-[1.45]";

const HUMAN_TIMELINE_ENTRY_CLASS = `${TIMELINE_ENTRY_BASE_CLASS} border border-crm-rule-box bg-crm-canvas`;

/**
 * Deliberately not a tint away from the human entry: a dashed rule and a
 * marker, the same visual vocabulary `Chip.tsx` uses for import debt, because
 * both say the same thing -- a value nobody chose by hand.
 */
const AUTO_APPLIED_TIMELINE_ENTRY_CLASS = `${TIMELINE_ENTRY_BASE_CLASS} border border-dashed border-crm-steel bg-crm-surface`;

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
      <p className="text-[14px] text-crm-steel">
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
              <time dateTime={event.createdAt} className="text-[12px] text-crm-steel">
                {formatEventTimestamp(event.createdAt)}
              </time>
              {isAutoApplied && (
                <span
                  data-testid="timeline-auto-applied-marker"
                  className="rounded-crm-badge border border-dashed border-crm-steel bg-crm-yellow px-1.5 py-0.5 text-[12px] leading-none text-crm-charcoal"
                >
                  Auto-applied
                </span>
              )}
            </div>
            <p data-testid="timeline-entry-title" className="font-medium text-crm-charcoal">
              {title}
            </p>
            {detail !== "" && <p className="text-crm-steel">{detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
