import { useCallback, useMemo, useState } from "react";
import { crm } from "@rgs/shared";
import { Link } from "react-router";
import { useAuth } from "../../lib/auth";
import { CrmLayout } from "../CrmLayout";
import { AgentPanel } from "../agent/AgentPanel";
import type { OpenReviewSummaryEntry } from "../api/crmClient";
import { useLedgerRows, usePartners, useReviewSummary } from "../api/hooks";
import {
  CARD_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PILL_OFF_CLASS,
  PILL_ON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";
import { CASE_STATUS_LABELS } from "../labels";
import { NewCaseDrawer } from "../newCase/NewCaseDrawer";
import { applyFilters, applySort, type LedgerFilters, type LedgerSort } from "./filters";
import { LedgerTable } from "./LedgerTable";
import { ViewChips } from "./ViewChips";

const DEFAULT_LEDGER_SORT: LedgerSort = { column: "receivedDate", direction: "desc" };

/**
 * The client-only slice of `LedgerFilters` -- everything except `statuses`
 * and `partnerId`, which `LedgerPage` already tracks separately as the
 * server-side filter state (`selectedCaseStatuses`/`selectedPartnerId`
 * below, unchanged since Task 10). Keeping these apart is what let Task 13
 * land without touching that existing state or the tests pinned to it.
 */
type ClientOnlyLedgerFilters = Omit<LedgerFilters, "statuses" | "partnerId">;

const NO_CLIENT_FILTERS: ClientOnlyLedgerFilters = {};

/**
 * Exactly one of these two filters is ever in force server-side (spec §2.1,
 * `LedgerAppliedQuery`): a partner filter and a status filter never both
 * apply. Choosing a partner clears the status selection and vice versa, so
 * the filter bar never shows an agent a status chip that the server is
 * silently ignoring underneath a partner filter.
 */
export function LedgerPage() {
  const { email: signedInUserEmail } = useAuth();
  const [selectedCaseStatuses, setSelectedCaseStatuses] = useState<crm.CaseStatus[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | undefined>(undefined);
  const [clientLedgerFilters, setClientLedgerFilters] = useState<ClientOnlyLedgerFilters>(NO_CLIENT_FILTERS);
  const [ledgerSort, setLedgerSort] = useState<LedgerSort>(DEFAULT_LEDGER_SORT);
  const [isNewCaseDrawerOpen, setIsNewCaseDrawerOpen] = useState(false);
  /**
   * R62: the grid's selection, lifted here so `CrmLayout`'s right column can
   * hand it to the agent. `useCallback` with `[]` deps keeps the identity
   * stable, so `LedgerTable`'s reporting effect fires on a real selection
   * change rather than on every render of this page.
   */
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const reportSelectedCaseIds = useCallback((nextSelectedCaseIds: string[]) => {
    setSelectedCaseIds((currentSelectedCaseIds) =>
      currentSelectedCaseIds.length === nextSelectedCaseIds.length &&
      currentSelectedCaseIds.every((caseId, index) => caseId === nextSelectedCaseIds[index])
        ? currentSelectedCaseIds
        : nextSelectedCaseIds,
    );
  }, []);

  const ledgerRowsQuery = useLedgerRows(selectedCaseStatuses, selectedPartnerId);
  const partnersQuery = usePartners();
  /**
   * Spec §7's review markers, read ONCE for the whole screen.
   *
   * The import left 3,958 open review items behind, and the summary route
   * exists precisely so that marking the rows carrying them costs one
   * projected read rather than one request per case. Indexed by `caseRef`
   * here, because that is the only identifier the summary carries -- it is
   * built from the review items themselves, which name a workbook ref and
   * never a `caseId`.
   *
   * A failed or still-loading summary yields an empty map and therefore no
   * markers, which is the honest degradation: a Ledger with no marks reads as
   * "nothing flagged", and the alternative (a banner about a review summary on
   * a screen whose job is cases) would put import plumbing in front of every
   * desk agent every time this one read is slow.
   */
  const reviewSummaryQuery = useReviewSummary();
  const reviewEntriesByCaseRef = useMemo(() => {
    const entriesByCaseRef = new Map<string, OpenReviewSummaryEntry>();
    for (const reviewEntry of reviewSummaryQuery.data?.entries ?? []) {
      entriesByCaseRef.set(reviewEntry.caseRef, reviewEntry);
    }
    return entriesByCaseRef;
  }, [reviewSummaryQuery.data]);

  const partnerNamesById = useMemo(() => {
    const namesById: Record<string, string> = {};
    for (const partner of partnersQuery.data ?? []) {
      namesById[partner.partnerId] = partner.canonicalName;
    }
    return namesById;
  }, [partnersQuery.data]);

  function toggleCaseStatus(caseStatus: crm.CaseStatus) {
    setSelectedPartnerId(undefined);
    setSelectedCaseStatuses((currentCaseStatuses) =>
      currentCaseStatuses.includes(caseStatus)
        ? currentCaseStatuses.filter((existingCaseStatus) => existingCaseStatus !== caseStatus)
        : [...currentCaseStatuses, caseStatus],
    );
  }

  function selectPartner(partnerId: string | undefined) {
    setSelectedCaseStatuses([]);
    setSelectedPartnerId(partnerId);
  }

  /** A saved (or built-in) view's full `LedgerFilters` split back into the
   * server-side state this page already owns and the client-only state
   * introduced in Task 13. */
  function applyLedgerView(viewFilters: LedgerFilters, viewSort: LedgerSort) {
    setSelectedCaseStatuses(viewFilters.statuses);
    setSelectedPartnerId(viewFilters.partnerId);
    setClientLedgerFilters({
      destinationCountry: viewFilters.destinationCountry,
      caseType: viewFilters.caseType,
      search: viewFilters.search,
      billingStatuses: viewFilters.billingStatuses,
    });
    setLedgerSort(viewSort);
  }

  const activeLedgerFilters: LedgerFilters = {
    statuses: selectedCaseStatuses,
    partnerId: selectedPartnerId,
    ...clientLedgerFilters,
  };

  const ledgerLoad = ledgerRowsQuery.data;
  const unreadableCaseCount = ledgerLoad?.unreadableCaseIds.length ?? 0;
  /**
   * D40 / finding #5: the review summary names the items it could not parse,
   * and nothing read that list -- so a case whose review items are unreadable
   * rendered as a CLEAN row, which inverts the whole argument for the markers
   * (spec §7: a dirty row must not look clean). It joins the partial-ledger
   * banner rather than getting a banner of its own: that banner is already a
   * `role="status"` stating several independent facts about how complete this
   * screen is, and this is one more.
   */
  const unreadableReviewItemCount = reviewSummaryQuery.data?.unreadableReviewItemIds.length ?? 0;
  const isLedgerPartial =
    Boolean(ledgerLoad?.truncated) || unreadableCaseCount > 0 || unreadableReviewItemCount > 0;

  const visibleLedgerRows = useMemo(() => {
    const loadedRows = ledgerLoad?.rows ?? [];
    const filteredRows = applyFilters(loadedRows, activeLedgerFilters, partnerNamesById);
    return applySort(filteredRows, ledgerSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerLoad?.rows, clientLedgerFilters, ledgerSort, partnerNamesById]);

  return (
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={selectedCaseIds} />}>
      <div className="flex h-full flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Ledger</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              {describeLedgerCount(visibleLedgerRows.length, ledgerLoad?.rows.length, ledgerRowsQuery.isLoading)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/crm/review" className={SECONDARY_BUTTON_CLASS}>
              Review queue
            </Link>
            <button type="button" onClick={() => setIsNewCaseDrawerOpen(true)} className={PRIMARY_BUTTON_CLASS}>
              New case
            </button>
          </div>
        </div>
        {isNewCaseDrawerOpen && <NewCaseDrawer onClose={() => setIsNewCaseDrawerOpen(false)} />}

        <div className={`${CARD_CLASS} flex flex-col gap-3 px-4 py-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${FIELD_LABEL_CLASS} mr-1`}>Status</span>
            {crm.CASE_STATUSES.map((caseStatus) => (
              // Never `disabled` while a partner filter is active: a desk agent
              // must always be able to click straight back into status
              // filtering in one step. `toggleCaseStatus` already clears the
              // partner selection, so disabling this button would be the only
              // thing standing between a partner-filtered view and a status
              // filter -- a dead end with no way out except the partner
              // dropdown's own "All partners" option.
              <button
                key={caseStatus}
                type="button"
                onClick={() => toggleCaseStatus(caseStatus)}
                aria-pressed={selectedCaseStatuses.includes(caseStatus)}
                className={selectedCaseStatuses.includes(caseStatus) ? PILL_ON_CLASS : PILL_OFF_CLASS}
              >
                {CASE_STATUS_LABELS[caseStatus]}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              Partner
              <select
                value={selectedPartnerId ?? ""}
                onChange={(changeEvent) => selectPartner(changeEvent.target.value || undefined)}
                className={`${INPUT_CLASS} min-w-56 font-normal`}
              >
                <option value="">All partners</option>
                {(partnersQuery.data ?? []).map((partner) => (
                  <option key={partner.partnerId} value={partner.partnerId}>
                    {partner.canonicalName}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              Search
              <input
                type="search"
                value={clientLedgerFilters.search ?? ""}
                onChange={(changeEvent) =>
                  setClientLedgerFilters((currentFilters) => ({
                    ...currentFilters,
                    search: changeEvent.target.value || undefined,
                  }))
                }
                placeholder="Search REF or partner"
                className={`${INPUT_CLASS} min-w-64 font-normal`}
              />
            </label>

            {signedInUserEmail !== null && (
              <div className="flex items-center gap-2 lg:ml-auto">
                <span className={FIELD_LABEL_CLASS}>Views</span>
                <ViewChips
                  userEmail={signedInUserEmail}
                  activeFilters={activeLedgerFilters}
                  activeSort={ledgerSort}
                  onApplyView={applyLedgerView}
                />
              </div>
            )}
          </div>
        </div>

        {isLedgerPartial && (
          <div
            role="status"
            className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
          >
            {describePartialLedgerBanner(
              Boolean(ledgerLoad?.truncated),
              ledgerLoad?.rows.length ?? 0,
              unreadableCaseCount,
              unreadableReviewItemCount,
            )}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {ledgerRowsQuery.isLoading ? (
            <p className="text-sm text-ink-soft">Loading the ledger…</p>
          ) : ledgerRowsQuery.isError ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
              The ledger could not be loaded: {String(ledgerRowsQuery.error)}
            </p>
          ) : (
            <LedgerTable
              rows={visibleLedgerRows}
              partnerNamesById={partnerNamesById}
              onSelectionChange={reportSelectedCaseIds}
              reviewEntriesByCaseRef={reviewEntriesByCaseRef}
            />
          )}
        </div>
      </div>
    </CrmLayout>
  );
}

/**
 * The line under the title. "Showing" is honest HERE because both numbers are
 * the client's own: rows on screen after the search box and view filters, and
 * rows the ledger LOADED. Neither claims to be the size of the whole ledger;
 * `describePartialLedgerBanner` below owns that boundary.
 */
function describeLedgerCount(
  visibleRowCount: number,
  loadedRowCount: number | undefined,
  isLoading: boolean,
): string {
  if (isLoading || loadedRowCount === undefined) return "Loading cases…";
  if (visibleRowCount === loadedRowCount) {
    return `${loadedRowCount.toLocaleString()} case${loadedRowCount === 1 ? "" : "s"}`;
  }
  return `Showing ${visibleRowCount.toLocaleString()} of ${loadedRowCount.toLocaleString()} loaded cases`;
}

/**
 * A silent partial ledger is the one thing this screen must never be. Both
 * sentences are independent -- either can appear alone, and when both
 * conditions hold both sentences appear, so neither reason can hide the
 * other.
 *
 * The truncated sentence deliberately never states a missing-row count:
 * `truncated` only means the page-filling walk stopped at `MAX_LEDGER_PAGES`
 * before its cursor ran out, and nothing in the response says how much
 * ledger sits past that point. Fabricating a total would be worse than
 * omitting one. What the client knows exactly is how many rows it LOADED --
 * `loadedRowCount` -- and that is the number a desk agent actually needs, to
 * judge whether the case they are hunting for could be past the edge of
 * this view.
 *
 * R48 (fix round 1, F6): "Loaded", never "Showing". Rows loaded and rows on
 * screen are two different numbers from Task 13 on -- `visibleLedgerRows` is
 * the loaded rows AFTER the client-side filters and the search box -- so a
 * truncated ledger plus any filter used to put "Showing the first 500 cases"
 * over a table of three. The NUMBER stays the loaded one on purpose: it names
 * the load boundary, which is the only thing this banner exists to say. It is
 * the verb that was false.
 */
function describePartialLedgerBanner(
  isTruncated: boolean,
  loadedRowCount: number,
  unreadableCaseCount: number,
  unreadableReviewItemCount: number,
): string {
  const sentences: string[] = [];
  if (isTruncated) {
    sentences.push(
      `Loaded the first ${loadedRowCount} case${loadedRowCount === 1 ? "" : "s"}; the ledger is longer than this view loads.`,
    );
  }
  if (unreadableCaseCount > 0) {
    sentences.push(
      `${unreadableCaseCount} case${unreadableCaseCount === 1 ? "" : "s"} could not be read from storage and ${unreadableCaseCount === 1 ? "is" : "are"} missing from this list.`,
    );
  }
  if (unreadableReviewItemCount > 0) {
    // Names the CONSEQUENCE, not just the count: an unreadable review item is
    // invisible on the row it belongs to, and a row that needs attention
    // looking clean is the thing a desk agent has to be told about. The count
    // is known exactly (it is `unreadableReviewItemIds.length`), the case it
    // belongs to is not -- the summary cannot say which case an item it could
    // not parse was about -- so the sentence does not pretend to name one.
    sentences.push(
      `${unreadableReviewItemCount} import-review item${unreadableReviewItemCount === 1 ? "" : "s"} could not be read, so a row that needs attention may look clean.`,
    );
  }
  return sentences.join(" ");
}
