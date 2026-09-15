import { crm } from "@rgs/shared";
import { useCase } from "../api/hooks";
import { AxisChip } from "../components/Chip";
import { COURIER_LABELS } from "../labels";

/**
 * The fixed height (px) of every line this component ever draws: the
 * one-line loading skeleton, the one-line "could not be loaded" message, and
 * each applicant's own line. All three share one height on purpose --
 * `LedgerTable.tsx`'s `estimateExpandedRowHeight` has to know how tall an
 * expanded row will be BEFORE `useCase` resolves (the virtualizer positions
 * every row up front, not after a fetch completes), and it can only compute
 * that from a line count if every line is the same size regardless of which
 * of the three states above produced it.
 */
export const APPLICANT_SUBROW_LINE_HEIGHT = 28;

interface ApplicantSubRowsProps {
  caseId: string;
}

function describeCourier(applicant: crm.CaseApplicant): string {
  if (applicant.courierMode === undefined) return "Not couriered";
  const courierLabel = COURIER_LABELS[applicant.courierMode];
  return applicant.trackingNumber === undefined ? courierLabel : `${courierLabel} · ${applicant.trackingNumber}`;
}

/**
 * The disclosed detail under an expanded Ledger row (Task 13, wired from
 * `LedgerTable`'s `→` on the REF column). `applicantSummary` on the
 * `LedgerRow` is only a roll-up -- the applicant records themselves are not
 * on the Ledger row, so this fetches the full case on mount (brief:
 * "Expanding fetches").
 *
 * R45 -- what this renders, corrected: `applicantRef · passportNumber ·
 * custody · outcome · courierMode + trackingNumber`. NOT a traveller name.
 * `CaseApplicantSchema` (packages/shared/src/crm/schemas.ts:83-93) carries no
 * name field; the name lives on a separate `CrmTraveller` record
 * (`fullName`, schemas.ts:61) that this app has no route to read by
 * `travellerId` -- `crmApi.ts` only exposes traveller lookups by passport
 * number or by full name, and the CRM client has no traveller methods at
 * all. Adding that read is explicitly out of scope for this task.
 */
export function ApplicantSubRows({ caseId }: ApplicantSubRowsProps) {
  const caseQuery = useCase(caseId);

  if (caseQuery.isLoading) {
    return (
      <div
        data-testid="applicant-subrows-loading"
        className="flex items-center bg-crm-surface px-4 text-[12px] text-crm-steel"
        style={{ height: APPLICANT_SUBROW_LINE_HEIGHT }}
      >
        Loading applicants…
      </div>
    );
  }

  const applicants = caseQuery.data?.applicants ?? [];

  // `CrmCaseSchema.applicants` requires at least one entry -- a real case
  // can never resolve to zero (R45's measured fact). An empty list here can
  // therefore only ever be a failure this query's own `isError` did not
  // itself flag (or a case handed to this component in a shape nothing
  // upstream should ever produce), never a case that genuinely has no
  // applicants. Rendering it as an ordinary empty state would hide exactly
  // the failure this guard exists to surface -- so this is the SAME message
  // a hard fetch error shows, never an empty list.
  if (caseQuery.isError || applicants.length === 0) {
    return (
      <div
        role="alert"
        data-testid="applicant-subrows-error"
        className="flex items-center bg-crm-surface px-4 text-[12px] text-crm-rose"
        style={{ height: APPLICANT_SUBROW_LINE_HEIGHT }}
      >
        The applicants for this case could not be loaded.
      </div>
    );
  }

  return (
    <div data-testid="applicant-subrows" role="rowgroup" className="bg-crm-surface">
      {applicants.map((applicant) => (
        <div
          key={applicant.applicantRef}
          data-testid="applicant-subrow"
          role="row"
          className="flex items-center gap-3 border-t border-crm-rule-row px-4 text-[12px] text-crm-charcoal"
          style={{ height: APPLICANT_SUBROW_LINE_HEIGHT }}
        >
          <span className="font-medium">{applicant.applicantRef}</span>
          <span className="text-crm-steel">{applicant.passportNumber ?? "No passport on file"}</span>
          <AxisChip axis="custody" value={applicant.custody} />
          <AxisChip axis="outcome" value={applicant.outcome} />
          <span>{describeCourier(applicant)}</span>
        </div>
      ))}
    </div>
  );
}
