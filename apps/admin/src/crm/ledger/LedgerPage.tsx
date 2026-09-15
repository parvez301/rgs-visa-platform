import { useCallback, useMemo, useState } from "react";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { CrmLayout } from "../CrmLayout";
import { AgentPanel } from "../agent/AgentPanel";
import type { OpenReviewSummaryEntry } from "../api/crmClient";
import { useLedgerRows, usePartners, useReviewSummary } from "../api/hooks";
import { CASE_STATUS_LABELS } from "../labels";
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
  const isLedgerPartial = Boolean(ledgerLoad?.truncated) || unreadableCaseCount > 0;

  const visibleLedgerRows = useMemo(() => {
    const loadedRows = ledgerLoad?.rows ?? [];
    const filteredRows = applyFilters(loadedRows, activeLedgerFilters, partnerNamesById);
    return applySort(filteredRows, ledgerSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerLoad?.rows, clientLedgerFilters, ledgerSort, partnerNamesById]);

  return (
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={selectedCaseIds} />}>
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-crm-charcoal">Status</span>
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
              className={`rounded-crm-control border px-2 py-1 text-[12px] ${
                selectedCaseStatuses.includes(caseStatus)
                  ? "border-crm-primary bg-crm-lavender text-crm-charcoal"
                  : "border-crm-rule-box text-crm-steel"
              }`}
            >
              {CASE_STATUS_LABELS[caseStatus]}
            </button>
          ))}

          <label className="ml-4 flex items-center gap-2 text-[13px] font-medium text-crm-charcoal">
            Partner
            <select
              value={selectedPartnerId ?? ""}
              onChange={(changeEvent) => selectPartner(changeEvent.target.value || undefined)}
              className="rounded-crm-control border border-crm-rule-box px-2 py-1 text-[12px] font-normal"
            >
              <option value="">All partners</option>
              {(partnersQuery.data ?? []).map((partner) => (
                <option key={partner.partnerId} value={partner.partnerId}>
                  {partner.canonicalName}
                </option>
              ))}
            </select>
          </label>

          <label className="ml-4 flex items-center gap-2 text-[13px] font-medium text-crm-charcoal">
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
              className="rounded-crm-control border border-crm-rule-box px-2 py-1 text-[12px] font-normal"
            />
          </label>
        </div>

        {signedInUserEmail !== null && (
          <ViewChips
            userEmail={signedInUserEmail}
            activeFilters={activeLedgerFilters}
            activeSort={ledgerSort}
            onApplyView={applyLedgerView}
          />
        )}

        {isLedgerPartial && (
          <div
            role="status"
            className="rounded-crm-control border border-dashed border-crm-steel bg-crm-yellow px-3 py-2 text-[13px] text-crm-charcoal"
          >
            {describePartialLedgerBanner(
              Boolean(ledgerLoad?.truncated),
              ledgerLoad?.rows.length ?? 0,
              unreadableCaseCount,
            )}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {ledgerRowsQuery.isLoading ? (
            <p className="text-crm-steel">Loading the ledger…</p>
          ) : ledgerRowsQuery.isError ? (
            <p className="text-crm-steel">
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
  return sentences.join(" ");
}
