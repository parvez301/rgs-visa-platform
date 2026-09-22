import { useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { CrmLayout } from "../CrmLayout";
import { AgentPanel } from "../agent/AgentPanel";
import { AxisChip } from "../components/Chip";
import { ConflictPrompt } from "../components/ConflictPrompt";
import { CARD_CLASS, FIELD_LABEL_CLASS, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from "../components/controls";
import {
  describeApplicantEditValue,
  useApplicantEdit,
  type ApplicantEdit,
  type ApplicantEditAxis,
} from "../api/applicantMutations";
import { crmClient } from "../api/crmClient";
import { useCase, useCaseEvents, usePartners } from "../api/hooks";
import { describeLedgerEditValue, useLedgerEdit, type LedgerEditColumn } from "../api/mutations";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  COURIER_LABELS,
  CUSTODY_LABELS,
  ENTRY_TYPE_LABELS,
  LINE_ITEM_KIND_LABELS,
  OUTCOME_LABELS,
  VISA_TYPE_LABELS,
  describeCaseType,
  formatInr,
} from "../labels";
import {
  allowedBillingStatusOptions,
  allowedCaseStatusOptions,
  allowedCustodyOptions,
  allowedOutcomeOptions,
  hasNoLegalMove,
} from "../transitions";
import { Timeline } from "./Timeline";
import { DocumentChecklistSection } from "./DocumentChecklistSection";

const NOT_RECORDED = "—";

const CONTROL_CLASS = `${INPUT_CLASS} py-1`;

const LOAD_FAILURE_CLASS =
  "rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900";

/**
 * The Case screen (spec §5): the shared case fields ONCE at the top, the
 * applicants below as a small table, then line items, notes and the audit
 * timeline.
 *
 * "Once at the top" is the whole shape. The spreadsheet this replaces carries
 * one row per applicant with every shared field copied down it, which is how a
 * REF ends up disagreeing with itself.
 *
 * The route param is read here and the screen itself is a separate component,
 * so a missing `:caseId` is answered before any query is started rather than
 * by firing a request for `/cases/`.
 */
export function CasePage() {
  const { caseId } = useParams();
  if (caseId === undefined || caseId === "") {
    return (
      // No case to inherit, so the panel is handed an empty selection rather
      // than a made-up one.
      <CrmLayout agentPanel={<AgentPanel />}>
        <div className="crm-root h-full overflow-y-auto">
          <p role="alert" className={LOAD_FAILURE_CLASS}>
            This link has no case reference in it, so there is no case to load.
          </p>
        </div>
      </CrmLayout>
    );
  }
  return <CaseScreen caseId={caseId} />;
}

function CaseScreen({ caseId }: { caseId: string }) {
  const caseQuery = useCase(caseId);
  const caseEventsQuery = useCaseEvents(caseId);
  const partnersQuery = usePartners();

  // R50/R49: one call each, per screen. Both hooks keep their own
  // `pendingConflict` in local state, and a second call site of either would
  // silently disagree with the first about whether a prompt is open.
  const {
    commitEdit: commitCaseEdit,
    pendingConflict: caseConflict,
    resolveConflict: resolveCaseConflict,
  } = useLedgerEdit();
  const {
    commitEdit: commitApplicantEdit,
    pendingConflict: applicantConflict,
    resolveConflict: resolveApplicantConflict,
  } = useApplicantEdit();

  const caseRecord = caseQuery.data;

  return (
    // R62: the Case screen's "selection" is the one case it is showing.
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={[caseId]} />}>
      <div className="crm-root relative h-full overflow-y-auto pb-20 text-sm">
        <Link to="/crm" className="mb-3 inline-block text-sm font-medium text-rgs-red-deep hover:underline">
          Back to the ledger
        </Link>
        {caseQuery.isLoading ? (
          <p className="text-sm text-ink-soft">Loading this case…</p>
        ) : caseQuery.isError || caseRecord === undefined ? (
          // Never an empty shell. A heading over blank fields and an empty
          // applicant table reads as a case with nothing on it, which is a
          // different -- and false -- claim from "this case could not be
          // read". The server's own words follow, not a paraphrase.
          <p role="alert" className={LOAD_FAILURE_CLASS}>
            This case could not be loaded.{" "}
            {caseQuery.error === null || caseQuery.error === undefined
              ? "The server gave no reason."
              : String(caseQuery.error.message)}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            <CaseHeader
              caseRecord={caseRecord}
              partnerName={
                partnersQuery.data?.find((partner) => partner.partnerId === caseRecord.partnerId)
                  ?.canonicalName ?? caseRecord.partnerId
              }
              onCommitCaseEdit={(column, nextValue) =>
                void commitCaseEdit({
                  caseId: caseRecord.caseId,
                  column,
                  previousValue: readCaseColumnValue(caseRecord, column),
                  nextValue,
                })
              }
            />

            <ApplicantsTable
              caseRecord={caseRecord}
              onCommitApplicantEdit={(edit) => void commitApplicantEdit(edit)}
            />

            <DocumentChecklistSection caseRecord={caseRecord} />

            <LineItemsTable caseRecord={caseRecord} />

            <CaseSection title="Timeline">
              {caseEventsQuery.isLoading ? (
                <p className="text-sm text-ink-soft">Loading the timeline…</p>
              ) : caseEventsQuery.isError ? (
                <p role="alert" className={LOAD_FAILURE_CLASS}>
                  The timeline could not be loaded, so this case's history is not shown. The case
                  itself is unaffected.
                </p>
              ) : (
                <Timeline events={caseEventsQuery.data ?? []} />
              )}
            </CaseSection>
          </div>
        )}

        {caseConflict !== undefined && (
          <ConflictPrompt
            serverMessage={caseConflict.serverMessage}
            yourValue={describeLedgerEditValue(caseConflict.edit)}
            onKeepTheirs={() => resolveCaseConflict("keepTheirs")}
            onKeepMine={() => resolveCaseConflict("keepMine")}
          />
        )}
        {applicantConflict !== undefined && (
          <ConflictPrompt
            serverMessage={applicantConflict.serverMessage}
            yourValue={describeApplicantEditValue(applicantConflict.edit)}
            onKeepTheirs={() => resolveApplicantConflict("keepTheirs")}
            onKeepMine={() => resolveApplicantConflict("keepMine")}
          />
        )}
      </div>
    </CrmLayout>
  );
}

/** The stored value one `LedgerEdit` column is about to move away from -- what its undo writes back. */
function readCaseColumnValue(caseRecord: crm.CrmCase, column: LedgerEditColumn): string | undefined {
  switch (column) {
    case "caseStatus":
      return caseRecord.caseStatus;
    case "billingStatus":
      return caseRecord.billingStatus;
    case "appointmentDate":
      return caseRecord.appointmentDate;
    case "visaType":
      return caseRecord.visaType;
  }
}

function CaseSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function CaseField({ fieldKey, label, children }: { fieldKey: string; label: string; children: ReactNode }) {
  return (
    <div data-testid={`case-field-${fieldKey}`} className="flex flex-col gap-1">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink">{children}</span>
    </div>
  );
}

/**
 * Every shared case field, once.
 *
 * R52: all the dates are rendered; exactly the four axes `LedgerEdit` already
 * supports are editable (`caseStatus`, `billingStatus`, `appointmentDate`,
 * `visaType`). `submissionDate` and `expectedCollectionDate` are accepted by
 * `PUT /cases/{caseId}` but have no `LedgerEdit` column, and widening that
 * union is a Task 12 surface with its own tests -- so they are read-only here
 * rather than wired to a control that would need a second, parallel write path.
 */
function CaseHeader({
  caseRecord,
  partnerName,
  onCommitCaseEdit,
}: {
  caseRecord: crm.CrmCase;
  partnerName: string;
  onCommitCaseEdit: (column: LedgerEditColumn, nextValue: string) => void;
}) {
  const caseStatusOptions = allowedCaseStatusOptions(caseRecord.caseStatus);
  const billingStatusOptions = allowedBillingStatusOptions(caseRecord.billingStatus);
  const isVisaCase = caseRecord.caseType === "VISA";

  return (
    <header className={`${CARD_CLASS} flex flex-col gap-5 p-5`}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mrz text-2xl font-bold tracking-normal text-ink">{caseRecord.caseRef}</h1>
        <AxisChip axis="caseStatus" value={caseRecord.caseStatus} />
        <AxisChip axis="billing" value={caseRecord.billingStatus} />
      </div>

      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <CaseField fieldKey="partner" label="Partner">
          {partnerName}
        </CaseField>
        <CaseField fieldKey="destinationCountry" label="Country">
          {caseRecord.destinationCountry}
        </CaseField>
        <CaseField fieldKey="caseType" label="Type">
          {describeCaseType(caseRecord)}
        </CaseField>

        <CaseField fieldKey="caseStatus" label="Case status">
          <select
            aria-label="Case status"
            value={caseRecord.caseStatus}
            disabled={hasNoLegalMove(caseStatusOptions)}
            title={
              hasNoLegalMove(caseStatusOptions)
                ? `A ${CASE_STATUS_LABELS[caseRecord.caseStatus].toLowerCase()} case cannot move to another status`
                : undefined
            }
            onChange={(changeEvent) => onCommitCaseEdit("caseStatus", changeEvent.target.value)}
            className={CONTROL_CLASS}
          >
            {caseStatusOptions.map((caseStatusOption) => (
              <option key={caseStatusOption} value={caseStatusOption}>
                {CASE_STATUS_LABELS[caseStatusOption]}
              </option>
            ))}
          </select>
        </CaseField>
        <CaseField fieldKey="billingStatus" label="Billing status">
          <select
            aria-label="Billing status"
            value={caseRecord.billingStatus}
            disabled={hasNoLegalMove(billingStatusOptions)}
            title={
              hasNoLegalMove(billingStatusOptions)
                ? `Billing is ${BILLING_LABELS[caseRecord.billingStatus].toLowerCase()} and cannot move again`
                : undefined
            }
            onChange={(changeEvent) => onCommitCaseEdit("billingStatus", changeEvent.target.value)}
            className={CONTROL_CLASS}
          >
            {billingStatusOptions.map((billingStatusOption) => (
              <option key={billingStatusOption} value={billingStatusOption}>
                {BILLING_LABELS[billingStatusOption]}
              </option>
            ))}
          </select>
        </CaseField>
        <CaseField fieldKey="visaType" label="Visa type">
          <select
            aria-label="Visa type"
            value={caseRecord.visaType ?? ""}
            disabled={!isVisaCase}
            title={isVisaCase ? undefined : "Only a VISA case can carry a visa type"}
            onChange={(changeEvent) => onCommitCaseEdit("visaType", changeEvent.target.value)}
            className={CONTROL_CLASS}
          >
            {/*
              No empty option, deliberately (fix round 1, F3): `PUT /cases/
              {caseId}` has no way to UNSET a visa type -- `updateCaseDetails`
              counts `visaType: ""` as a change and `CrmCaseSchema.parse` then
              rejects it against `z.enum(VISA_TYPES)`, so choosing it cleared
              the field optimistically and snapped back with no explanation (a
              non-409 rolls back silently, by design). A case with no visa type
              yet still selects nothing -- `value=""` matches no option, so the
              control renders blank -- and picking a real one commits it.
            */}
            {crm.VISA_TYPES.map((visaType) => (
              <option key={visaType} value={visaType}>
                {VISA_TYPE_LABELS[visaType]}
              </option>
            ))}
          </select>
        </CaseField>

        <CaseField fieldKey="receivedDate" label="Received">
          {caseRecord.receivedDate}
        </CaseField>
        <CaseField fieldKey="submissionDate" label="Submitted">
          {caseRecord.submissionDate ?? NOT_RECORDED}
        </CaseField>
        <CaseField fieldKey="appointmentDate" label="Appointment">
          <AppointmentDateControl
            storedDate={caseRecord.appointmentDate}
            onCommitDate={(confirmedDate) => onCommitCaseEdit("appointmentDate", confirmedDate)}
          />
        </CaseField>
        <CaseField fieldKey="expectedCollectionDate" label="Expected collection">
          {caseRecord.expectedCollectionDate ?? NOT_RECORDED}
        </CaseField>
        <CaseField fieldKey="entryType" label="Entry type">
          {caseRecord.entryType === undefined ? NOT_RECORDED : ENTRY_TYPE_LABELS[caseRecord.entryType]}
        </CaseField>
        <CaseField fieldKey="courierDate" label="Couriered">
          {caseRecord.courierDate ?? NOT_RECORDED}
        </CaseField>
      </div>
      <CaseField fieldKey="remarks" label="Remarks">
        <span className="whitespace-pre-wrap">{caseRecord.remarks ?? NOT_RECORDED}</span>
      </CaseField>
    </header>
  );
}

/**
 * The appointment date, committed when the human confirms it.
 *
 * Fix round 1, F4. A `<input type="date">` fires React's `onChange` on every
 * native `input` event, and a keyboard-typed year walks the value through
 * `0002-03-20`, `0020-03-20` and `0202-03-20` before reaching `2026-03-20`.
 * Each of those is a COMPLETE, schema-valid date, so committing on change did
 * not send one write and three rejections -- it sent four accepted writes, the
 * first three of them to years nobody typed on purpose, each with its own
 * optimistic patch, its own event on the audit timeline and its own undo
 * toast.
 *
 * The contract is `EditableCell`'s, so the two surfaces agree about what
 * "confirm" means: commit on blur or on Enter, never before. A draft that
 * equals the stored value is not a write, and an EMPTY draft is not a write
 * either -- clearing the field would send `appointmentDate: ""`, which fails
 * the schema's `isoDate` regex exactly as the empty visa type did. The input
 * still shows the cleared value: the draft is what a desk agent typed, and
 * lying about that is worse than letting them tab away and see it come back.
 */
function AppointmentDateControl({
  storedDate,
  onCommitDate,
}: {
  storedDate: string | undefined;
  onCommitDate: (confirmedDate: string) => void;
}) {
  const [draftDate, setDraftDate] = useState(storedDate ?? "");
  // The stored value this draft was last seeded from. Compared during render
  // (React's "adjusting state when a prop changes" pattern) rather than in an
  // effect, so a rollback or a refetch that moves the date never paints the
  // stale draft for a frame first.
  const [lastSeenStoredDate, setLastSeenStoredDate] = useState(storedDate);
  const alreadyCommittedDateRef = useRef<string | undefined>(undefined);
  if (storedDate !== lastSeenStoredDate) {
    setLastSeenStoredDate(storedDate);
    setDraftDate(storedDate ?? "");
    alreadyCommittedDateRef.current = undefined;
  }

  function commitDraftDate() {
    if (draftDate === "" || draftDate === (storedDate ?? "")) return;
    // Enter commits and then the input is usually blurred (by the human, or by
    // the browser). Without this the second event would send the same date a
    // second time, because the optimistic patch that makes `storedDate` agree
    // is a microtask behind.
    if (alreadyCommittedDateRef.current === draftDate) return;
    alreadyCommittedDateRef.current = draftDate;
    onCommitDate(draftDate);
  }

  return (
    <input
      type="date"
      aria-label="Appointment date"
      value={draftDate}
      onChange={(changeEvent) => setDraftDate(changeEvent.target.value)}
      onBlur={commitDraftDate}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter") {
          keyboardEvent.preventDefault();
          commitDraftDate();
        } else if (keyboardEvent.key === "Escape") {
          keyboardEvent.preventDefault();
          setDraftDate(storedDate ?? "");
        }
      }}
      className={CONTROL_CLASS}
    />
  );
}

/**
 * R45 again (Task 13's ruling, unchanged here): a `CaseApplicant` carries no
 * name. The name lives on a separate `CrmTraveller` record this app has no
 * route to read by `travellerId`, so this renders what exists --
 * `applicantRef`, passport, custody, outcome, courier -- and invents nothing.
 */
function ApplicantsTable({
  caseRecord,
  onCommitApplicantEdit,
}: {
  caseRecord: crm.CrmCase;
  onCommitApplicantEdit: (edit: ApplicantEdit) => void;
}) {
  return (
    <CaseSection title={`Applicants (${caseRecord.applicants.length})`}>
      <div className={`${CARD_CLASS} overflow-x-auto`}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="mrz border-b border-line bg-mist text-[10px] text-ink-soft">
              <th className="px-4 py-2.5 font-medium">Applicant</th>
              <th className="px-4 py-2.5 font-medium">Passport</th>
              <th className="px-4 py-2.5 font-medium">Custody</th>
              <th className="px-4 py-2.5 font-medium">Outcome</th>
              <th className="px-4 py-2.5 font-medium">Courier</th>
            </tr>
          </thead>
          <tbody>
            {caseRecord.applicants.map((applicant) => (
              <tr
                key={applicant.applicantRef}
                data-testid="case-applicant-row"
                className="border-t border-line"
              >
                <td className="px-4 py-2.5 font-medium text-ink">{applicant.applicantRef}</td>
                <td className="px-4 py-2.5 text-ink-soft">
                  {applicant.passportNumber === undefined ? (
                    "No passport on file"
                  ) : (
                    <span className="mrz text-xs">{applicant.passportNumber}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <ApplicantAxisControl
                    axis="custody"
                    applicantRef={applicant.applicantRef}
                    currentValue={applicant.custody}
                    allowedValues={allowedCustodyOptions(applicant.custody)}
                    optionLabels={CUSTODY_LABELS}
                    noLegalMoveReason={`This passport is ${CUSTODY_LABELS[applicant.custody].toLowerCase()}; custody cannot move from here`}
                    onCommit={(toValue) =>
                      onCommitApplicantEdit({
                        caseId: caseRecord.caseId,
                        applicantRef: applicant.applicantRef,
                        axis: "custody",
                        fromValue: applicant.custody,
                        toValue,
                      })
                    }
                  />
                </td>
                <td className="px-4 py-2.5">
                  <ApplicantAxisControl
                    axis="outcome"
                    applicantRef={applicant.applicantRef}
                    currentValue={applicant.outcome}
                    allowedValues={allowedOutcomeOptions(applicant.outcome)}
                    optionLabels={OUTCOME_LABELS}
                    noLegalMoveReason={`This applicant is ${OUTCOME_LABELS[applicant.outcome].toLowerCase()}; the outcome cannot move from here`}
                    onCommit={(toValue) =>
                      onCommitApplicantEdit({
                        caseId: caseRecord.caseId,
                        applicantRef: applicant.applicantRef,
                        axis: "outcome",
                        fromValue: applicant.outcome,
                        toValue,
                      })
                    }
                  />
                </td>
                <td className="px-4 py-2.5 text-ink">{describeCourier(applicant)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CaseSection>
  );
}

const APPLICANT_AXIS_CONTROL_LABELS: Record<ApplicantEditAxis, string> = {
  custody: "Custody",
  outcome: "Outcome",
};

/**
 * One applicant's one axis. The accessible name carries the `applicantRef`
 * ("Custody for applicant A2") because a case has several of these controls
 * and they are otherwise indistinguishable to anyone not looking at the row
 * they sit in -- which includes a screen-reader user and a test asserting that
 * the right applicant's route was called.
 */
function ApplicantAxisControl({
  axis,
  applicantRef,
  currentValue,
  allowedValues,
  optionLabels,
  noLegalMoveReason,
  onCommit,
}: {
  axis: ApplicantEditAxis;
  applicantRef: string;
  currentValue: string;
  allowedValues: readonly string[];
  optionLabels: Readonly<Record<string, string>>;
  noLegalMoveReason: string;
  onCommit: (toValue: string) => void;
}) {
  const isFrozen = hasNoLegalMove(allowedValues);
  return (
    <select
      aria-label={`${APPLICANT_AXIS_CONTROL_LABELS[axis]} for applicant ${applicantRef}`}
      value={currentValue}
      disabled={isFrozen}
      title={isFrozen ? noLegalMoveReason : undefined}
      onChange={(changeEvent) => onCommit(changeEvent.target.value)}
      className={CONTROL_CLASS}
    >
      {allowedValues.map((allowedValue) => (
        <option key={allowedValue} value={allowedValue}>
          {optionLabels[allowedValue] ?? allowedValue}
        </option>
      ))}
    </select>
  );
}

function describeCourier(applicant: crm.CaseApplicant): string {
  if (applicant.courierMode === undefined) return "Not couriered";
  const courierLabel = COURIER_LABELS[applicant.courierMode];
  return applicant.trackingNumber === undefined
    ? courierLabel
    : `${courierLabel} · ${applicant.trackingNumber}`;
}

/**
 * R51: read-only table for lines already on the case. Invoice download sits
 * beside the heading -- the admin still has no line-item write method here.
 *
 * `amountInr` is the UNIT price and `totalInr` is the case sum of
 * `amountInr × quantity` across items (`LineItemSchema`'s own comment). Both
 * the unit price and the line total are shown, because showing only the first
 * tells a desk agent a two-quantity line cost half what it did.
 */
function LineItemsTable({ caseRecord }: { caseRecord: crm.CrmCase }) {
  const { idToken } = useAuth();
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [isDownloadingInvoice, setIsDownloadingInvoice] = useState(false);

  async function downloadInvoice(): Promise<void> {
    if (idToken === null) return;
    setIsDownloadingInvoice(true);
    setInvoiceError(null);
    try {
      const invoice = await crmClient.downloadCaseInvoice(idToken, caseRecord.caseId);
      const binary = atob(invoice.pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: invoice.contentType }));
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = invoice.fileName;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      setInvoiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDownloadingInvoice(false);
    }
  }

  return (
    <CaseSection
      title="Line items"
      action={
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={caseRecord.lineItems.length === 0 || isDownloadingInvoice || idToken === null}
          onClick={() => void downloadInvoice()}
        >
          {isDownloadingInvoice ? "Preparing invoice…" : "Download invoice"}
        </button>
      }
    >
      {invoiceError !== null && (
        <p role="alert" className="mb-2 text-sm text-rose-800">
          {invoiceError}
        </p>
      )}
      <div className={`${CARD_CLASS} overflow-x-auto`}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="mrz border-b border-line bg-mist text-[10px] text-ink-soft">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-4 py-2.5 font-medium">Kind</th>
              <th className="px-4 py-2.5 font-medium">Quantity</th>
              <th className="px-4 py-2.5 font-medium">Unit price</th>
              <th className="px-4 py-2.5 font-medium">Line total</th>
            </tr>
          </thead>
          <tbody>
            {caseRecord.lineItems.length === 0 ? (
              <tr className="border-t border-line">
                <td colSpan={5} className="px-4 py-2.5 text-ink-soft">
                  No line items on this case.
                </td>
              </tr>
            ) : (
              caseRecord.lineItems.map((lineItem) => (
                <tr
                  key={lineItem.code}
                  data-testid="case-line-item-row"
                  className="border-t border-line"
                >
                  <td className="px-4 py-2.5 text-ink">{lineItem.label}</td>
                  <td className="px-4 py-2.5 text-ink-soft">{LINE_ITEM_KIND_LABELS[lineItem.kind]}</td>
                  <td className="px-4 py-2.5 text-ink">{lineItem.quantity}</td>
                  <td className="px-4 py-2.5 text-ink">{formatInr(lineItem.amountInr)}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {formatInr(lineItem.amountInr * lineItem.quantity)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-mist">
              <td colSpan={4} className={`${FIELD_LABEL_CLASS} px-4 py-2.5`}>
                Case total
              </td>
              <td data-testid="case-total" className="px-4 py-2.5 font-semibold text-ink">
                {formatInr(caseRecord.totalInr)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </CaseSection>
  );
}
