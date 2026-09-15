import { crm } from "@rgs/shared";

/**
 * The client-side filter state a desk agent can apply on top of whatever the
 * server already returned (Task 13; spec §2.1's fixed split is in the module
 * comment on `applyFilters` below).
 *
 * `billingStatuses` is not in Task 13's original interface list -- it was
 * added because the "Awaiting payment" built-in view (see `views.ts`) has no
 * other way to express "billingStatus in BILL_SENT/PART_PAID": every other
 * field here is either a status list already covered by `statuses`, or an
 * axis the built-in view does not care about. `billingStatus` sits on every
 * `LedgerRow` already loaded, so filtering by it needs no extra fetch --
 * exactly the reasoning spec §2.1 gives for running `destinationCountry` and
 * `caseType` client-side.
 */
export interface LedgerFilters {
  statuses: crm.CaseStatus[];
  partnerId?: string;
  destinationCountry?: string;
  caseType?: crm.CaseType;
  search?: string;
  billingStatuses?: crm.BillingStatus[];
}

/**
 * `column` is deliberately a closed set of the Ledger's own sortable fields,
 * not `keyof crm.LedgerRow` -- sorting by `caseId` or `updatedAt` is not a
 * desk-agent-facing operation, and a closed union is what keeps
 * `applySort`'s `readSortValue` exhaustive (TypeScript refuses to compile a
 * missing `case` the day a fifth sortable column is added).
 */
export interface LedgerSort {
  column: "receivedDate" | "appointmentDate" | "totalInr" | "caseRef";
  direction: "asc" | "desc";
}

/**
 * The client-side portion of filtering only (spec §2.1, restated in the Task
 * 13 brief): `statuses` and `partnerId` are enforced by the server query
 * that produced `rows` in the first place -- an index answers them there, so
 * a row reaching this function has already cleared that gate. This function
 * deliberately does not re-check either field: doing so would be a silent
 * no-op whenever a caller passes rows fetched with the same statuses/
 * partnerId (the overwhelmingly common case, since `LedgerPage` is the only
 * real caller and always does), and silently WRONG the one time a caller
 * passes rows that were not fetched that way -- nothing here could tell the
 * two apart, so it should not pretend to filter on fields it cannot verify.
 *
 * `destinationCountry`, `caseType` and `billingStatuses` are plain equality/
 * membership checks over columns already sitting on every loaded row -- no
 * fetch, no roll-up, no partial data to worry about.
 *
 * The text search (R45): a `LedgerRow` carries no traveller name -- the
 * columns are case-level, and the name lives on applicant/traveller records
 * this function never sees. It matches `caseRef` and the partner's
 * canonical name only. `partnerNamesById` is a third parameter, not part of
 * `LedgerFilters`, because a name lookup is live reference data (`usePartners`),
 * not filter state a saved view should freeze into `localStorage` -- a
 * partner renamed after a view was saved must resolve through the CURRENT
 * name map, not a stale one baked into the view.
 */
export function applyFilters(
  rows: crm.LedgerRow[],
  filters: LedgerFilters,
  partnerNamesById: Record<string, string> = {},
): crm.LedgerRow[] {
  const normalizedSearchTerm = filters.search?.trim().toLowerCase();
  const hasSearchTerm = normalizedSearchTerm !== undefined && normalizedSearchTerm.length > 0;

  return rows.filter((row) => {
    if (filters.destinationCountry !== undefined && row.destinationCountry !== filters.destinationCountry) {
      return false;
    }
    if (filters.caseType !== undefined && row.caseType !== filters.caseType) {
      return false;
    }
    if (
      filters.billingStatuses !== undefined &&
      filters.billingStatuses.length > 0 &&
      !filters.billingStatuses.includes(row.billingStatus)
    ) {
      return false;
    }
    if (hasSearchTerm) {
      const partnerName = partnerNamesById[row.partnerId] ?? "";
      const matchesCaseRef = row.caseRef.toLowerCase().includes(normalizedSearchTerm);
      const matchesPartnerName = partnerName.toLowerCase().includes(normalizedSearchTerm);
      if (!matchesCaseRef && !matchesPartnerName) return false;
    }
    return true;
  });
}

/**
 * Reads the value `sort.column` names off a row, typed loosely enough to
 * cover both the string columns (compared with `localeCompare`) and the one
 * numeric column (`totalInr`, compared numerically) -- `applySort` decides
 * which comparison to run from the runtime type of what comes back, not from
 * `sort.column` a second time, so the two can never disagree about which
 * column is numeric.
 */
function readSortValue(row: crm.LedgerRow, column: LedgerSort["column"]): string | number | undefined {
  switch (column) {
    case "receivedDate":
      return row.receivedDate;
    case "appointmentDate":
      return row.appointmentDate;
    case "totalInr":
      return row.totalInr;
    case "caseRef":
      return row.caseRef;
  }
}

/**
 * A row missing the sorted column (only `appointmentDate` can be absent)
 * always sorts last, in BOTH directions -- flipping `direction` reorders
 * what is known, never promotes what is missing to the top. Toggling
 * direction on "Appointment" must never be the one way to hunt for cases
 * with no appointment date; that is not what a direction toggle means.
 */
export function applySort(rows: crm.LedgerRow[], sort: LedgerSort): crm.LedgerRow[] {
  const directionMultiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((rowLeft, rowRight) => {
    const valueLeft = readSortValue(rowLeft, sort.column);
    const valueRight = readSortValue(rowRight, sort.column);
    if (valueLeft === undefined && valueRight === undefined) return 0;
    if (valueLeft === undefined) return 1;
    if (valueRight === undefined) return -1;
    if (typeof valueLeft === "number" && typeof valueRight === "number") {
      return (valueLeft - valueRight) * directionMultiplier;
    }
    return String(valueLeft).localeCompare(String(valueRight)) * directionMultiplier;
  });
}
