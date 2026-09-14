import { useMemo, useState } from "react";
import { crm } from "@rgs/shared";
import { CrmLayout } from "../CrmLayout";
import { useLedgerRows, usePartners } from "../api/hooks";
import { CASE_STATUS_LABELS } from "../labels";
import { LedgerTable } from "./LedgerTable";

/**
 * Exactly one of these two filters is ever in force server-side (spec §2.1,
 * `LedgerAppliedQuery`): a partner filter and a status filter never both
 * apply. Choosing a partner clears the status selection and vice versa, so
 * the filter bar never shows an agent a status chip that the server is
 * silently ignoring underneath a partner filter.
 */
export function LedgerPage() {
  const [selectedCaseStatuses, setSelectedCaseStatuses] = useState<crm.CaseStatus[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | undefined>(undefined);

  const ledgerRowsQuery = useLedgerRows(selectedCaseStatuses, selectedPartnerId);
  const partnersQuery = usePartners();

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

  const ledgerLoad = ledgerRowsQuery.data;
  const unreadableCaseCount = ledgerLoad?.unreadableCaseIds.length ?? 0;
  const isLedgerPartial = Boolean(ledgerLoad?.truncated) || unreadableCaseCount > 0;

  return (
    <CrmLayout>
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
        </div>

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
            <LedgerTable rows={ledgerLoad?.rows ?? []} partnerNamesById={partnerNamesById} />
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
 * omitting one. What the client knows exactly is how many rows it loaded --
 * `shownRowCount` -- and that is the number a desk agent actually needs, to
 * judge whether the case they are hunting for could be past the edge of
 * this view.
 */
function describePartialLedgerBanner(
  isTruncated: boolean,
  shownRowCount: number,
  unreadableCaseCount: number,
): string {
  const sentences: string[] = [];
  if (isTruncated) {
    sentences.push(
      `Showing the first ${shownRowCount} case${shownRowCount === 1 ? "" : "s"}. The ledger is longer than this view loads.`,
    );
  }
  if (unreadableCaseCount > 0) {
    sentences.push(
      `${unreadableCaseCount} case${unreadableCaseCount === 1 ? "" : "s"} could not be read from storage and ${unreadableCaseCount === 1 ? "is" : "are"} missing from this list.`,
    );
  }
  return sentences.join(" ");
}
