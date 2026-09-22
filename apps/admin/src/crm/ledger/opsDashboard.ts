import { crm } from "@rgs/shared";

export interface OpsDashboardCounts {
  collectToday: number;
  appointmentsToday: number;
  pendingLive: number;
}

/**
 * Counts over already-loaded ledger rows for the ops strip. Live statuses
 * only — closed / withdrawn / etc. are not today's work queue.
 */
export function countOpsDashboard(
  rows: readonly crm.LedgerRow[],
  todayIso: string,
): OpsDashboardCounts {
  const liveStatuses = new Set<string>(crm.LIVE_CASE_STATUSES);
  let collectToday = 0;
  let appointmentsToday = 0;
  let pendingLive = 0;

  for (const row of rows) {
    if (!liveStatuses.has(row.caseStatus)) continue;
    pendingLive += 1;
    if (row.expectedCollectionDate === todayIso) collectToday += 1;
    if (row.appointmentDate === todayIso) appointmentsToday += 1;
  }

  return { collectToday, appointmentsToday, pendingLive };
}
