import { crm } from "@rgs/shared";

export interface OpsDashboardCounts {
  collectToday: number;
  appointmentsToday: number;
  /** Live cases with an appointment date strictly after today. */
  appointmentsUpcoming: number;
  pendingLive: number;
}

/**
 * Counts over already-loaded ledger rows for the Queues strip. Live statuses
 * only — closed / withdrawn / etc. are not the work queue.
 *
 * Callers must pass the **unfiltered live-work set** (all live statuses, no
 * appointment/collection date filter). Counting from a date-scoped table load
 * (e.g. Appointments today) makes Upcoming/Collect flicker to 0.
 */
export function countOpsDashboard(
  rows: readonly crm.LedgerRow[],
  todayIso: string,
): OpsDashboardCounts {
  const liveStatuses = new Set<string>(crm.LIVE_CASE_STATUSES);
  let collectToday = 0;
  let appointmentsToday = 0;
  let appointmentsUpcoming = 0;
  let pendingLive = 0;

  for (const row of rows) {
    if (!liveStatuses.has(row.caseStatus)) continue;
    pendingLive += 1;
    if (row.expectedCollectionDate === todayIso) collectToday += 1;
    if (row.appointmentDate === todayIso) appointmentsToday += 1;
    if (row.appointmentDate !== undefined && row.appointmentDate > todayIso) {
      appointmentsUpcoming += 1;
    }
  }

  return { collectToday, appointmentsToday, appointmentsUpcoming, pendingLive };
}
