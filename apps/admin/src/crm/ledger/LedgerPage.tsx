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
import { CASE_STATUS_LABELS, REVIEW_REASON_LABELS } from "../labels";
import { NewCaseDrawer } from "../newCase/NewCaseDrawer";
import { applyFilters, applySort, localTodayIso, type LedgerFilters, type LedgerSort } from "./filters";
import { BulkActionsBar } from "./BulkActionsBar";
import { LedgerSkeleton } from "./LedgerSkeleton";
import { LedgerTable } from "./LedgerTable";
import { countOpsDashboard } from "./opsDashboard";
import {
  appointmentsTodayViewId,
  collectTodayViewId,
  findBuiltInLedgerView,
  liveWorkViewId,
} from "./views";
import { ViewChips } from "./ViewChips";

const DEFAULT_LIVE_WORK = findBuiltInLedgerView(liveWorkViewId())!;

/**
 * The client-only slice of `LedgerFilters` -- everything except `statuses`
 * and `partnerId`, which `LedgerPage` already tracks separately as the
 * server-side filter state (`selectedCaseStatuses`/`selectedPartnerId`
 * below, unchanged since Task 10). Keeping these apart is what let Task 13
 * land without touching that existing state or the tests pinned to it.
 */
type ClientOnlyLedgerFilters = Omit<LedgerFilters, "statuses" | "partnerId">;

/**
 * Exactly one of these two filters is ever in force server-side (spec §2.1,
 * `LedgerAppliedQuery`): a partner filter and a status filter never both
 * apply. Choosing a partner clears the status selection and vice versa, so
 * the filter bar never shows an agent a status chip that the server is
 * silently ignoring underneath a partner filter.
 */
const ALL_CASES = "";
const WITH_ANY_ISSUE = "__any_issue__";
const WITHOUT_ISSUES = "__no_issue__";
type IssueFilter = typeof ALL_CASES | typeof WITH_ANY_ISSUE | typeof WITHOUT_ISSUES | crm.ReviewReason;

/** Exported for the filter's own test; the page is otherwise the only caller. */
export function rowMatchesIssueFilter(
  reviewEntry: OpenReviewSummaryEntry | undefined,
  issueFilter: IssueFilter,
): boolean {
  const openReasons = reviewEntry?.openReasons ?? [];
  if (issueFilter === ALL_CASES) return true;
  if (issueFilter === WITH_ANY_ISSUE) return openReasons.length > 0;
  if (issueFilter === WITHOUT_ISSUES) return openReasons.length === 0;
  return openReasons.includes(issueFilter);
}

function clientFiltersFromView(viewFilters: LedgerFilters): ClientOnlyLedgerFilters {
  return {
    destinationCountry: viewFilters.destinationCountry,
    caseType: viewFilters.caseType,
    search: viewFilters.search,
    billingStatuses: viewFilters.billingStatuses,
    appointmentDateOn: viewFilters.appointmentDateOn,
    expectedCollectionDateOn: viewFilters.expectedCollectionDateOn,
  };
}

export function LedgerPage() {
  const { email: signedInUserEmail } = useAuth();
  // Default Live work: smaller first fetch and matches the daily work queue.
  const [selectedCaseStatuses, setSelectedCaseStatuses] = useState<crm.CaseStatus[]>([
    ...DEFAULT_LIVE_WORK.filters.statuses,
  ]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | undefined>(undefined);
  const [clientLedgerFilters, setClientLedgerFilters] = useState<ClientOnlyLedgerFilters>(() =>
    clientFiltersFromView(DEFAULT_LIVE_WORK.filters),
  );
  const [ledgerSort, setLedgerSort] = useState<LedgerSort>(DEFAULT_LIVE_WORK.sort);
  const [activeViewId, setActiveViewId] = useState<string | undefined>(liveWorkViewId());
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);
  const [isNewCaseDrawerOpen, setIsNewCaseDrawerOpen] = useState(false);
  const [selectedIssueFilter, setSelectedIssueFilter] = useState<IssueFilter>(ALL_CASES);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [selectionClearToken, setSelectionClearToken] = useState(0);
  const reportSelectedCaseIds = useCallback((nextSelectedCaseIds: string[]) => {
    setSelectedCaseIds((currentSelectedCaseIds) =>
      currentSelectedCaseIds.length === nextSelectedCaseIds.length &&
      currentSelectedCaseIds.every((caseId, index) => caseId === nextSelectedCaseIds[index])
        ? currentSelectedCaseIds
        : nextSelectedCaseIds,
    );
  }, []);

  function clearLedgerSelection(): void {
    setSelectedCaseIds([]);
    setSelectionClearToken((currentToken) => currentToken + 1);
  }

  const ledgerRowsQuery = useLedgerRows(selectedCaseStatuses, selectedPartnerId);
  const partnersQuery = usePartners();
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
    setActiveViewId(undefined);
    setSelectedCaseStatuses((currentCaseStatuses) =>
      currentCaseStatuses.includes(caseStatus)
        ? currentCaseStatuses.filter((existingCaseStatus) => existingCaseStatus !== caseStatus)
        : [...currentCaseStatuses, caseStatus],
    );
  }

  function selectPartner(partnerId: string | undefined) {
    setSelectedCaseStatuses([]);
    setActiveViewId(undefined);
    setSelectedPartnerId(partnerId);
  }

  function applyLedgerView(viewFilters: LedgerFilters, viewSort: LedgerSort) {
    setSelectedCaseStatuses(viewFilters.statuses);
    setSelectedPartnerId(viewFilters.partnerId);
    setClientLedgerFilters(clientFiltersFromView(viewFilters));
    setLedgerSort(viewSort);
  }

  const activeLedgerFilters: LedgerFilters = {
    statuses: selectedCaseStatuses,
    partnerId: selectedPartnerId,
    ...clientLedgerFilters,
  };

  const ledgerLoad = ledgerRowsQuery.data;
  const unreadableCaseCount = ledgerLoad?.unreadableCaseIds.length ?? 0;
  const unreadableReviewItemCount = reviewSummaryQuery.data?.unreadableReviewItemIds.length ?? 0;
  const isLedgerPartial =
    Boolean(ledgerLoad?.truncated) || unreadableCaseCount > 0 || unreadableReviewItemCount > 0;

  const visibleLedgerRows = useMemo(() => {
    const loadedRows = ledgerLoad?.rows ?? [];
    const filteredRows = applyFilters(loadedRows, activeLedgerFilters, partnerNamesById).filter((row) =>
      rowMatchesIssueFilter(reviewEntriesByCaseRef.get(row.caseRef), selectedIssueFilter),
    );
    return applySort(filteredRows, ledgerSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerLoad?.rows, clientLedgerFilters, ledgerSort, partnerNamesById, reviewEntriesByCaseRef, selectedIssueFilter]);

  const issueCaseCounts = useMemo(() => {
    const countByReason = new Map<crm.ReviewReason, number>();
    let withIssueCount = 0;
    for (const row of ledgerLoad?.rows ?? []) {
      const reviewEntry = reviewEntriesByCaseRef.get(row.caseRef);
      if (reviewEntry === undefined || reviewEntry.openReasons.length === 0) continue;
      withIssueCount += 1;
      for (const reason of reviewEntry.openReasons) {
        countByReason.set(reason, (countByReason.get(reason) ?? 0) + 1);
      }
    }
    return { countByReason, withIssueCount, withoutIssueCount: (ledgerLoad?.rows.length ?? 0) - withIssueCount };
  }, [ledgerLoad?.rows, reviewEntriesByCaseRef]);

  const todayIso = localTodayIso();
  const opsCounts = useMemo(
    () => countOpsDashboard(ledgerLoad?.rows ?? [], todayIso),
    [ledgerLoad?.rows, todayIso],
  );
  const openReviewCaseCount = reviewSummaryQuery.data?.entries.length ?? 0;
  const isFetchingMore = ledgerRowsQuery.isFetchingMore === true;

  function applyBuiltInViewById(viewId: string) {
    const builtInView = findBuiltInLedgerView(viewId);
    if (builtInView === undefined) return;
    setActiveViewId(viewId);
    applyLedgerView(builtInView.filters, builtInView.sort);
  }

  const statusSummaryLabel =
    selectedCaseStatuses.length === 0
      ? "All statuses"
      : selectedCaseStatuses.length === crm.CASE_STATUSES.length
        ? "All statuses"
        : selectedCaseStatuses.length <= 2
          ? selectedCaseStatuses.map((status) => CASE_STATUS_LABELS[status]).join(", ")
          : `${selectedCaseStatuses.length} statuses`;

  const hasFirstPage = ledgerLoad !== undefined;
  const showSkeleton = !hasFirstPage && (ledgerRowsQuery.isLoading || ledgerRowsQuery.isFetching);
  const showError = ledgerRowsQuery.isError && !hasFirstPage;

  return (
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={selectedCaseIds} />}>
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Ledger</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              {describeLedgerCount(
                visibleLedgerRows.length,
                ledgerLoad?.rows.length,
                !hasFirstPage,
                isFetchingMore,
              )}
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

        <div
          className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-line pb-2 text-sm"
          aria-label="Today's work"
        >
          <span className="text-xs font-medium uppercase tracking-wide text-ink-soft">Today</span>
          <button
            type="button"
            onClick={() => applyBuiltInViewById(collectTodayViewId())}
            className="text-ink hover:underline"
          >
            Collect{" "}
            <span className="tabular-nums text-ink-soft">
              {opsCounts.collectToday.toLocaleString()}
              {isFetchingMore ? "…" : ""}
            </span>
          </button>
          <button
            type="button"
            onClick={() => applyBuiltInViewById(appointmentsTodayViewId())}
            className="text-ink hover:underline"
          >
            Appointments{" "}
            <span className="tabular-nums text-ink-soft">
              {opsCounts.appointmentsToday.toLocaleString()}
              {isFetchingMore ? "…" : ""}
            </span>
          </button>
          <button
            type="button"
            onClick={() => applyBuiltInViewById(liveWorkViewId())}
            className="text-ink hover:underline"
          >
            Pending{" "}
            <span className="tabular-nums text-ink-soft">
              {opsCounts.pendingLive.toLocaleString()}
              {isFetchingMore ? "…" : ""}
            </span>
          </button>
          <Link to="/crm/review" className="text-ink hover:underline">
            Open review{" "}
            <span className="tabular-nums text-ink-soft">{openReviewCaseCount.toLocaleString()}</span>
          </Link>
        </div>

        {isNewCaseDrawerOpen && <NewCaseDrawer onClose={() => setIsNewCaseDrawerOpen(false)} />}

        <div className={`${CARD_CLASS} flex flex-col gap-3 px-4 py-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-expanded={isStatusMenuOpen}
              onClick={() => setIsStatusMenuOpen((isOpen) => !isOpen)}
              className={isStatusMenuOpen ? PILL_ON_CLASS : PILL_OFF_CLASS}
            >
              Status · {statusSummaryLabel}
            </button>
            {isStatusMenuOpen &&
              crm.CASE_STATUSES.map((caseStatus) => (
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
                placeholder="Search REF, partner, name, or passport"
                className={`${INPUT_CLASS} min-w-64 font-normal`}
              />
            </label>

            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              Issue
              <select
                value={selectedIssueFilter}
                onChange={(changeEvent) => setSelectedIssueFilter(changeEvent.target.value as IssueFilter)}
                className={`${INPUT_CLASS} min-w-56 font-normal`}
              >
                <option value={ALL_CASES}>All cases</option>
                <option value={WITH_ANY_ISSUE}>
                  With an open issue ({issueCaseCounts.withIssueCount.toLocaleString()})
                </option>
                <option value={WITHOUT_ISSUES}>
                  Without open issues ({issueCaseCounts.withoutIssueCount.toLocaleString()})
                </option>
                {crm.REVIEW_REASONS.filter(
                  (reason) =>
                    (issueCaseCounts.countByReason.get(reason) ?? 0) > 0 || reason === selectedIssueFilter,
                ).map((reason) => (
                  <option key={reason} value={reason}>
                    {REVIEW_REASON_LABELS[reason]} (
                    {(issueCaseCounts.countByReason.get(reason) ?? 0).toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {signedInUserEmail !== null && (
            <div className="flex flex-col gap-1 border-t border-line pt-3">
              <span className={FIELD_LABEL_CLASS}>Views</span>
              <ViewChips
                userEmail={signedInUserEmail}
                activeFilters={activeLedgerFilters}
                activeSort={ledgerSort}
                onApplyView={applyLedgerView}
                activeViewId={activeViewId}
                onActiveViewIdChange={setActiveViewId}
              />
            </div>
          )}
        </div>

        <BulkActionsBar selectedCaseIds={selectedCaseIds} onClearSelection={clearLedgerSelection} />

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
          {showSkeleton ? (
            <LedgerSkeleton />
          ) : showError ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
              The ledger could not be loaded: {String(ledgerRowsQuery.error)}
            </p>
          ) : (
            <LedgerTable
              rows={visibleLedgerRows}
              partnerNamesById={partnerNamesById}
              onSelectionChange={reportSelectedCaseIds}
              reviewEntriesByCaseRef={reviewEntriesByCaseRef}
              selectionClearToken={selectionClearToken}
            />
          )}
        </div>
      </div>
    </CrmLayout>
  );
}

function describeLedgerCount(
  visibleRowCount: number,
  loadedRowCount: number | undefined,
  isWaitingForFirstPage: boolean,
  isFetchingMore: boolean,
): string {
  if (isWaitingForFirstPage || loadedRowCount === undefined) return "Loading cases…";
  const base =
    visibleRowCount === loadedRowCount
      ? `${loadedRowCount.toLocaleString()} case${loadedRowCount === 1 ? "" : "s"}`
      : `Showing ${visibleRowCount.toLocaleString()} of ${loadedRowCount.toLocaleString()} loaded cases`;
  return isFetchingMore ? `${base} · loading more…` : base;
}

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
    sentences.push(
      `${unreadableReviewItemCount} import-review item${unreadableReviewItemCount === 1 ? "" : "s"} could not be read, so a row that needs attention may look clean.`,
    );
  }
  return sentences.join(" ");
}
