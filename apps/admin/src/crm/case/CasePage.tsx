import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crm } from "@rgs/shared";
import { useAdminAccess } from "../../lib/adminAccess";
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
import {
  crmClient,
  type CaseView,
  type CrmEventView,
  type UpdateCaseDetailsBody,
} from "../api/crmClient";
import { crmQueryKeys, useCase, useCaseEvents, usePartners } from "../api/hooks";
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
import { EditCaseDrawer } from "./EditCaseDrawer";

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

  const { idToken } = useAuth();
  const { canWrite } = useAdminAccess();
  const canWriteCrm = canWrite("crm");
  const queryClient = useQueryClient();
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);
  const [clientEmailErrorMessage, setClientEmailErrorMessage] = useState<string | null>(null);
  const [vendorEmailErrorMessage, setVendorEmailErrorMessage] = useState<string | null>(null);
  const [detailsErrorMessage, setDetailsErrorMessage] = useState<string | null>(null);
  const clientEmailMutation = useMutation({
    mutationFn: (clientEmail: string | null) => crmClient.updateCaseDetails(idToken!, caseId, { clientEmail }),
    onMutate: () => setClientEmailErrorMessage(null),
    onError: (mutationError) =>
      setClientEmailErrorMessage(
        `Not saved: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`,
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseId) }),
  });
  const vendorEmailMutation = useMutation({
    mutationFn: (input: { partnerId: string; contactEmail: string | null }) =>
      crmClient.updatePartnerContact(idToken!, input.partnerId, { contactEmail: input.contactEmail }),
    onMutate: () => setVendorEmailErrorMessage(null),
    onError: (mutationError) =>
      setVendorEmailErrorMessage(
        `Not saved: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`,
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: crmQueryKeys.partners() }),
  });
  const detailsMutation = useMutation({
    mutationFn: (patch: UpdateCaseDetailsBody) => crmClient.updateCaseDetails(idToken!, caseId, patch),
    onMutate: () => setDetailsErrorMessage(null),
    onError: (mutationError) =>
      setDetailsErrorMessage(
        `Not saved: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseId) });
      void queryClient.invalidateQueries({ queryKey: ["crm", "ledger"] });
    },
  });

  const caseRecord: CaseView | undefined = caseQuery.data;

  return (
    // R62: the Case screen's "selection" is the one case it is showing.
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={[caseId]} />}>
      <div className="crm-root relative h-full overflow-y-auto pb-20 text-sm">
        {caseQuery.isLoading ? (
          <div className="flex flex-col gap-3">
            <BackToCasesLink />
            <p className="text-sm text-ink-soft">Loading this case…</p>
          </div>
        ) : caseQuery.isError || caseRecord === undefined ? (
          // Never an empty shell. A heading over blank fields and an empty
          // applicant table reads as a case with nothing on it, which is a
          // different -- and false -- claim from "this case could not be
          // read". The server's own words follow, not a paraphrase.
          <div className="flex flex-col gap-3">
            <BackToCasesLink />
            <p role="alert" className={LOAD_FAILURE_CLASS}>
              This case could not be loaded.{" "}
              {caseQuery.error === null || caseQuery.error === undefined
                ? "The server gave no reason."
                : String(caseQuery.error.message)}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <CaseWorkHeader
              caseRecord={caseRecord}
              onCommitCaseEdit={(column, nextValue) =>
                void commitCaseEdit({
                  caseId: caseRecord.caseId,
                  column,
                  previousValue: readCaseColumnValue(caseRecord, column),
                  nextValue,
                })
              }
              onOpenEdit={canWriteCrm ? () => setIsEditDrawerOpen(true) : undefined}
            />

            <div data-testid="case-body" className="flex flex-col gap-5 lg:flex-row lg:items-start">
              <div data-testid="case-primary-column" className="flex min-w-0 flex-1 flex-col gap-5">
                <ApplicantsTable
                  caseRecord={caseRecord}
                  travellers={caseRecord.travellers}
                  onCommitApplicantEdit={(edit) => void commitApplicantEdit(edit)}
                />

                <DocumentChecklistSection caseRecord={caseRecord} />

                <CaseSection title="Timeline">
                  {caseEventsQuery.isLoading ? (
                    <p className="text-sm text-ink-soft">Loading the timeline…</p>
                  ) : caseEventsQuery.isError ? (
                    <p role="alert" className={LOAD_FAILURE_CLASS}>
                      The timeline could not be loaded, so this case's history is not shown. The case
                      itself is unaffected.
                    </p>
                  ) : (
                    <CompactTimeline events={caseEventsQuery.data ?? []} />
                  )}
                </CaseSection>
              </div>

              <div
                data-testid="case-context-column"
                className="flex min-w-0 flex-col gap-5 lg:w-[22rem] lg:shrink-0 xl:w-[26rem]"
              >
                <CaseContextFields
                  caseRecord={caseRecord}
                  partnerName={
                    partnersQuery.data?.find((partner) => partner.partnerId === caseRecord.partnerId)
                      ?.canonicalName ?? caseRecord.partnerId
                  }
                  partnerContactEmail={
                    partnersQuery.data?.find((partner) => partner.partnerId === caseRecord.partnerId)
                      ?.contactEmail
                  }
                  onCommitCaseEdit={(column, nextValue) =>
                    void commitCaseEdit({
                      caseId: caseRecord.caseId,
                      column,
                      previousValue: readCaseColumnValue(caseRecord, column),
                      nextValue,
                    })
                  }
                  onCommitClientEmail={(clientEmail) => clientEmailMutation.mutate(clientEmail)}
                  onCommitVendorEmail={(contactEmail) =>
                    vendorEmailMutation.mutate({ partnerId: caseRecord.partnerId, contactEmail })
                  }
                  onCommitDetails={(patch) => detailsMutation.mutate(patch)}
                  canWriteCrm={canWriteCrm}
                  clientEmailErrorMessage={clientEmailErrorMessage}
                  vendorEmailErrorMessage={vendorEmailErrorMessage}
                  detailsErrorMessage={detailsErrorMessage}
                />

                <LineItemsTable caseRecord={caseRecord} />
              </div>
            </div>
          </div>
        )}

        {isEditDrawerOpen && canWriteCrm && caseRecord !== undefined && (
          <EditCaseDrawer caseRecord={caseRecord} onClose={() => setIsEditDrawerOpen(false)} />
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
 * The sticky work header: what this case IS and the two controls a desk agent
 * moves most (case status, billing status), plus the route back to the
 * ledger. Everything else lives in `CaseContextFields`.
 *
 * R52: exactly the four axes `LedgerEdit` already supports are editable
 * (`caseStatus`, `billingStatus`, `appointmentDate`, `visaType`). The write
 * callbacks are the ones `CaseScreen` already owned; only their placement moved.
 */
function CaseWorkHeader({
  caseRecord,
  onCommitCaseEdit,
  onOpenEdit,
}: {
  caseRecord: crm.CrmCase;
  onCommitCaseEdit: (column: LedgerEditColumn, nextValue: string) => void;
  /** Absent for a read-only role: the button is not offered at all. */
  onOpenEdit?: () => void;
}) {
  const caseStatusOptions = allowedCaseStatusOptions(caseRecord.caseStatus);
  const billingStatusOptions = allowedBillingStatusOptions(caseRecord.billingStatus);

  return (
    <header
      data-testid="case-work-header"
      className={`${CARD_CLASS} sticky top-0 z-10 flex flex-col gap-3 px-5 py-4`}
    >
      <BackToCasesLink />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mrz text-2xl font-bold tracking-normal text-ink">{caseRecord.caseRef}</h1>
        {caseRecord.groupName !== undefined && (
          <span className="text-base font-semibold text-ink-soft">{caseRecord.groupName}</span>
        )}
        <AxisChip axis="caseStatus" value={caseRecord.caseStatus} />
        <AxisChip axis="billing" value={caseRecord.billingStatus} />
        {onOpenEdit !== undefined && (
          <button type="button" onClick={onOpenEdit} className={`${SECONDARY_BUTTON_CLASS} ml-auto`}>
            Edit details
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
          <span data-testid="case-field-destinationCountry">{caseRecord.destinationCountry}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="case-field-caseType">{describeCaseType(caseRecord)}</span>
        </p>
        <HeaderSelect fieldKey="caseStatus" label="Case status">
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
        </HeaderSelect>
        <HeaderSelect fieldKey="billingStatus" label="Billing status">
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
        </HeaderSelect>
      </div>
    </header>
  );
}

function HeaderSelect({ fieldKey, label, children }: { fieldKey: string; label: string; children: ReactNode }) {
  return (
    <div data-testid={`case-field-${fieldKey}`} className="flex items-center gap-2">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      {children}
    </div>
  );
}

function BackToCasesLink() {
  return (
    <Link to="/crm" className="inline-block text-sm font-medium text-rgs-red-deep hover:underline">
      ← Cases
    </Link>
  );
}

/**
 * The shared case fields that are reference material rather than the work
 * itself, once each: partner and emails, visa type, and the dates. The
 * partner block is here, not above the applicants.
 */
function CaseContextFields({
  caseRecord,
  partnerName,
  partnerContactEmail,
  onCommitCaseEdit,
  onCommitClientEmail,
  onCommitVendorEmail,
  onCommitDetails,
  canWriteCrm,
  clientEmailErrorMessage,
  vendorEmailErrorMessage,
  detailsErrorMessage,
}: {
  caseRecord: crm.CrmCase;
  partnerName: string;
  partnerContactEmail?: string;
  onCommitCaseEdit: (column: LedgerEditColumn, nextValue: string) => void;
  onCommitClientEmail: (clientEmail: string | null) => void;
  onCommitVendorEmail: (contactEmail: string | null) => void;
  onCommitDetails: (patch: UpdateCaseDetailsBody) => void;
  canWriteCrm: boolean;
  clientEmailErrorMessage: string | null;
  vendorEmailErrorMessage: string | null;
  detailsErrorMessage: string | null;
}) {
  const isVisaCase = caseRecord.caseType === "VISA";

  return (
    <CaseSection title="Case details">
      <div className={`${CARD_CLASS} flex flex-col gap-4 p-4`}>
        {detailsErrorMessage !== null && (
          <p role="alert" className="text-sm text-rose-800">
            {detailsErrorMessage}
          </p>
        )}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <CaseField fieldKey="partner" label="Partner">
            <span className="flex flex-col gap-1">
              <span>{partnerName}</span>
              <InlineEmailControl
                label="Vendor email"
                storedValue={partnerContactEmail}
                placeholder="Add vendor email"
                errorMessage={vendorEmailErrorMessage}
                onCommit={onCommitVendorEmail}
              />
            </span>
          </CaseField>
          <CaseField fieldKey="clientEmail" label="Client email">
            <InlineEmailControl
              label="Client email"
              storedValue={caseRecord.clientEmail}
              placeholder="Add client email"
              errorMessage={clientEmailErrorMessage}
              onCommit={onCommitClientEmail}
            />
          </CaseField>
          <CaseField fieldKey="visaType" label="Visa type">
            <select
              aria-label="Visa type"
              value={caseRecord.visaType ?? ""}
              disabled={!isVisaCase || !canWriteCrm}
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
            {canWriteCrm ? (
              <CaseDateControl
                label="Received date"
                storedDate={caseRecord.receivedDate}
                allowClear={false}
                onCommitDate={(confirmedDate) => onCommitDetails({ receivedDate: confirmedDate })}
              />
            ) : (
              caseRecord.receivedDate
            )}
          </CaseField>
          <CaseField fieldKey="submissionDate" label="Online submission">
            {canWriteCrm ? (
              <CaseDateControl
                label="Online submission date"
                storedDate={caseRecord.submissionDate}
                allowClear
                onCommitDate={(confirmedDate) =>
                  onCommitDetails({ submissionDate: confirmedDate === "" ? null : confirmedDate })
                }
              />
            ) : (
              (caseRecord.submissionDate ?? NOT_RECORDED)
            )}
          </CaseField>
          <CaseField fieldKey="appointmentDate" label="Appointment">
            <AppointmentDateControl
              storedDate={caseRecord.appointmentDate}
              onCommitDate={(confirmedDate) => onCommitCaseEdit("appointmentDate", confirmedDate)}
            />
          </CaseField>
          <CaseField fieldKey="expectedCollectionDate" label="Expected collection">
            {canWriteCrm ? (
              <CaseDateControl
                label="Expected collection date"
                storedDate={caseRecord.expectedCollectionDate}
                allowClear
                onCommitDate={(confirmedDate) =>
                  onCommitDetails({
                    expectedCollectionDate: confirmedDate === "" ? null : confirmedDate,
                  })
                }
              />
            ) : (
              (caseRecord.expectedCollectionDate ?? NOT_RECORDED)
            )}
          </CaseField>
          <CaseField fieldKey="entryType" label="Entry type">
            {canWriteCrm ? (
              <select
                aria-label="Entry type"
                value={caseRecord.entryType ?? ""}
                onChange={(changeEvent) => {
                  const nextValue = changeEvent.target.value;
                  onCommitDetails({
                    entryType: nextValue === "" ? null : (nextValue as crm.EntryType),
                  });
                }}
                className={CONTROL_CLASS}
              >
                <option value="">Not set</option>
                {crm.ENTRY_TYPES.map((entryType) => (
                  <option key={entryType} value={entryType}>
                    {ENTRY_TYPE_LABELS[entryType]}
                  </option>
                ))}
              </select>
            ) : caseRecord.entryType === undefined ? (
              NOT_RECORDED
            ) : (
              ENTRY_TYPE_LABELS[caseRecord.entryType]
            )}
          </CaseField>
          <CaseField fieldKey="courierDate" label="Couriered">
            {caseRecord.courierDate ?? NOT_RECORDED}
          </CaseField>
        </div>
        <CaseField fieldKey="remarks" label="Remarks">
          {canWriteCrm ? (
            <InlineRemarksControl
              storedValue={caseRecord.remarks}
              onCommit={(remarks) => onCommitDetails({ remarks })}
            />
          ) : (
            <span className="whitespace-pre-wrap">{caseRecord.remarks ?? NOT_RECORDED}</span>
          )}
        </CaseField>
      </div>
    </CaseSection>
  );
}

/**
 * The audit timeline, trimmed to its MOST RECENT {@link COMPACT_TIMELINE_LIMIT}
 * entries when long so it does not bury the applicants' page. The API returns
 * oldest first and `Timeline` does not re-sort, so the recent window is the
 * tail of the list, still shown in the API's order. `Timeline` itself is
 * untouched and the events query is unchanged.
 */
const COMPACT_TIMELINE_LIMIT = 8;

function CompactTimeline({ events }: { events: CrmEventView[] }) {
  const [showAll, setShowAll] = useState(false);
  const isLong = events.length > COMPACT_TIMELINE_LIMIT;
  const visibleEvents = isLong && !showAll ? events.slice(-COMPACT_TIMELINE_LIMIT) : events;
  return (
    <div className="flex flex-col gap-2">
      <Timeline events={visibleEvents} />
      {isLong && (
        <button
          type="button"
          className={`${SECONDARY_BUTTON_CLASS} self-start`}
          onClick={() => setShowAll((previous) => !previous)}
        >
          {showAll ? "Show fewer events" : `Show all ${events.length} events`}
        </button>
      )}
    </div>
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
  return (
    <CaseDateControl
      label="Appointment date"
      storedDate={storedDate}
      allowClear={false}
      onCommitDate={onCommitDate}
    />
  );
}

/** Date field with blur/Enter commit; optional clear when `allowClear` is true. */
function CaseDateControl({
  label,
  storedDate,
  allowClear,
  onCommitDate,
}: {
  label: string;
  storedDate: string | undefined;
  allowClear: boolean;
  onCommitDate: (confirmedDate: string) => void;
}) {
  const [draftDate, setDraftDate] = useState(storedDate ?? "");
  const [lastSeenStoredDate, setLastSeenStoredDate] = useState(storedDate);
  const alreadyCommittedDateRef = useRef<string | undefined>(undefined);
  if (storedDate !== lastSeenStoredDate) {
    setLastSeenStoredDate(storedDate);
    setDraftDate(storedDate ?? "");
    alreadyCommittedDateRef.current = undefined;
  }

  function commitDraftDate() {
    if (draftDate === (storedDate ?? "")) return;
    if (!allowClear && draftDate === "") return;
    if (alreadyCommittedDateRef.current === draftDate) return;
    alreadyCommittedDateRef.current = draftDate;
    onCommitDate(draftDate);
  }

  return (
    <input
      type="date"
      aria-label={label}
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

function InlineRemarksControl({
  storedValue,
  onCommit,
}: {
  storedValue: string | undefined;
  onCommit: (remarks: string | null) => void;
}) {
  const [draftValue, setDraftValue] = useState(storedValue ?? "");
  const [lastSeenStoredValue, setLastSeenStoredValue] = useState(storedValue);
  const alreadyCommittedValueRef = useRef<string | null | undefined>(undefined);
  if (storedValue !== lastSeenStoredValue) {
    setLastSeenStoredValue(storedValue);
    setDraftValue(storedValue ?? "");
    alreadyCommittedValueRef.current = undefined;
  }

  function commitDraft() {
    const trimmedDraft = draftValue.trim();
    if (trimmedDraft === (storedValue ?? "")) return;
    const confirmedValue = trimmedDraft === "" ? null : trimmedDraft;
    if (alreadyCommittedValueRef.current === confirmedValue) return;
    alreadyCommittedValueRef.current = confirmedValue;
    onCommit(confirmedValue);
  }

  return (
    <textarea
      aria-label="Remarks"
      rows={3}
      value={draftValue}
      onChange={(changeEvent) => setDraftValue(changeEvent.target.value)}
      onBlur={commitDraft}
      className={`${CONTROL_CLASS} w-full resize-y`}
    />
  );
}

/**
 * One email address, committed when the human confirms it: the
 * `AppointmentDateControl` contract (blur or Enter commits, Escape reverts,
 * an unchanged draft is not a write). Unlike the date, an EMPTY draft IS a
 * write: it is how the desk clears an address, and `onCommit` receives
 * `null` for it so the caller sends `null`, never `""`, which the server
 * would reject as a malformed address.
 */
function InlineEmailControl({
  label,
  storedValue,
  placeholder,
  errorMessage,
  onCommit,
}: {
  label: string;
  storedValue: string | undefined;
  placeholder: string;
  errorMessage: string | null;
  onCommit: (confirmedValue: string | null) => void;
}) {
  const [draftValue, setDraftValue] = useState(storedValue ?? "");
  const [lastSeenStoredValue, setLastSeenStoredValue] = useState(storedValue);
  const [lastSeenErrorMessage, setLastSeenErrorMessage] = useState(errorMessage);
  const alreadyCommittedValueRef = useRef<string | null | undefined>(undefined);
  if (storedValue !== lastSeenStoredValue) {
    setLastSeenStoredValue(storedValue);
    setDraftValue(storedValue ?? "");
    alreadyCommittedValueRef.current = undefined;
  }
  if (errorMessage !== lastSeenErrorMessage) {
    // A rejected PUT leaves the typed value sitting in the box with no
    // explanation, and `alreadyCommittedValueRef` would then block a retry of
    // that same address. On a fresh failure (null -> a message) the draft
    // reverts to what is actually stored and the "already committed" guard is
    // cleared, exactly as the `storedValue` block above does for a change
    // that lands.
    setLastSeenErrorMessage(errorMessage);
    if (lastSeenErrorMessage === null && errorMessage !== null) {
      setDraftValue(storedValue ?? "");
      alreadyCommittedValueRef.current = undefined;
    }
  }

  function commitDraft() {
    const trimmedDraft = draftValue.trim();
    if (trimmedDraft === (storedValue ?? "")) return;
    const confirmedValue = trimmedDraft === "" ? null : trimmedDraft;
    // Enter commits and then the input is usually blurred (by the human, or by
    // the browser). Without this the second event would send the same address
    // a second time, because the optimistic patch that makes `storedValue`
    // agree is a microtask behind.
    if (alreadyCommittedValueRef.current === confirmedValue) return;
    alreadyCommittedValueRef.current = confirmedValue;
    onCommit(confirmedValue);
  }

  return (
    <span className="flex flex-col gap-1">
      <input
        type="email"
        aria-label={label}
        value={draftValue}
        placeholder={placeholder}
        onChange={(changeEvent) => setDraftValue(changeEvent.target.value)}
        onBlur={commitDraft}
        onKeyDown={(keyboardEvent) => {
          if (keyboardEvent.key === "Enter") {
            keyboardEvent.preventDefault();
            commitDraft();
          } else if (keyboardEvent.key === "Escape") {
            keyboardEvent.preventDefault();
            setDraftValue(storedValue ?? "");
          }
        }}
        className={CONTROL_CLASS}
      />
      {errorMessage !== null && (
        <p role="alert" className="mb-2 text-sm text-rose-800">
          {errorMessage}
        </p>
      )}
    </span>
  );
}

/**
 * Names arrive on the single-case read (`CaseView.travellers`, spec
 * 2026-09-25 D7), which lifts the old R45 ruling on evidence. A traveller the
 * server could not resolve shows the shared "Unnamed applicant" placeholder;
 * a mutation response without the map falls back the same way until the
 * refetch lands.
 */
function ApplicantsTable({
  caseRecord,
  travellers,
  onCommitApplicantEdit,
}: {
  caseRecord: crm.CrmCase;
  travellers: crm.CaseTravellerMap | undefined;
  onCommitApplicantEdit: (edit: ApplicantEdit) => void;
}) {
  return (
    <CaseSection title={`Applicants (${caseRecord.applicants.length})`}>
      <div className={`${CARD_CLASS} overflow-x-auto`}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="mrz border-b border-line bg-mist text-[10px] text-ink-soft">
              <th className="px-4 py-2.5 font-medium">REF NO</th>
              <th className="px-4 py-2.5 font-medium">Name</th>
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
                <td className="mrz px-4 py-2.5 text-xs font-semibold text-ink">
                  {crm.displayApplicantRef(caseRecord.caseRef, caseRecord.applicants.length, applicant)}
                </td>
                <td className="px-4 py-2.5 font-medium text-ink">{crm.displayApplicantName(travellers, applicant)}</td>
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
 * Line items on the case: table + add form (CRM writers) + invoice download.
 *
 * `amountInr` is the UNIT price and `totalInr` is the case sum of
 * `amountInr × quantity` across items (`LineItemSchema`'s own comment). Both
 * the unit price and the line total are shown, because showing only the first
 * tells a desk agent a two-quantity line cost half what it did.
 */
function LineItemsTable({ caseRecord }: { caseRecord: crm.CrmCase }) {
  const { idToken } = useAuth();
  const { canWrite } = useAdminAccess();
  const canWriteCrm = canWrite("crm");
  const queryClient = useQueryClient();
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [isDownloadingInvoice, setIsDownloadingInvoice] = useState(false);
  const [lineItemCode, setLineItemCode] = useState(crm.LINE_ITEM_CATALOG[0]?.code ?? "");
  const [quantity, setQuantity] = useState("1");
  const [unitPriceInr, setUnitPriceInr] = useState("");
  const [selectedLineIndexes, setSelectedLineIndexes] = useState<number[]>(() =>
    caseRecord.lineItems.map((_lineItem, index) => index),
  );
  const [lastSeenLineCount, setLastSeenLineCount] = useState(caseRecord.lineItems.length);
  if (caseRecord.lineItems.length !== lastSeenLineCount) {
    setLastSeenLineCount(caseRecord.lineItems.length);
    setSelectedLineIndexes(caseRecord.lineItems.map((_lineItem, index) => index));
  }

  const addLineItemMutation = useMutation({
    mutationFn: (input: crm.AddLineItemBody) =>
      crmClient.addLineItem(idToken!, caseRecord.caseId, input),
    onSuccess: () => {
      setQuantity("1");
      setUnitPriceInr("");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: ["crm", "ledger"] });
    },
  });

  async function downloadInvoice(): Promise<void> {
    if (idToken === null) return;
    if (selectedLineIndexes.length === 0) {
      setInvoiceError("Select at least one line item to invoice.");
      return;
    }
    setIsDownloadingInvoice(true);
    setInvoiceError(null);
    try {
      const invoice = await crmClient.downloadCaseInvoice(idToken, caseRecord.caseId, {
        lineItemIndexes: selectedLineIndexes,
      });
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

  function submitLineItem(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsedQuantity = Number.parseInt(quantity, 10);
    const parsedUnitPrice = Number.parseInt(unitPriceInr, 10);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 1) return;
    if (!Number.isFinite(parsedUnitPrice) || parsedUnitPrice < 0) return;
    addLineItemMutation.mutate({
      lineItemCode,
      quantity: parsedQuantity,
      unitPriceInr: parsedUnitPrice,
    });
  }

  function toggleLineSelection(lineIndex: number, checked: boolean): void {
    setSelectedLineIndexes((previous) => {
      if (checked) {
        return previous.includes(lineIndex) ? previous : [...previous, lineIndex].sort((a, b) => a - b);
      }
      return previous.filter((index) => index !== lineIndex);
    });
  }

  return (
    <CaseSection
      title="Line items"
      action={
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={
            caseRecord.lineItems.length === 0 ||
            selectedLineIndexes.length === 0 ||
            isDownloadingInvoice ||
            idToken === null
          }
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
      {canWriteCrm && (
        <form
          onSubmit={submitLineItem}
          className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-mist p-3"
          data-testid="add-line-item-form"
        >
          <label className="min-w-48 flex-1">
            <span className={FIELD_LABEL_CLASS}>Item</span>
            <select
              className={`${INPUT_CLASS} w-full`}
              value={lineItemCode}
              onChange={(event) => setLineItemCode(event.target.value)}
              required
            >
              {crm.LINE_ITEM_CATALOG.map((definition) => (
                <option key={definition.code} value={definition.code}>
                  {definition.label}
                </option>
              ))}
            </select>
          </label>
          <label className="w-24">
            <span className={FIELD_LABEL_CLASS}>Qty</span>
            <input
              type="number"
              min={1}
              step={1}
              required
              className={`${INPUT_CLASS} w-full`}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <label className="w-36">
            <span className={FIELD_LABEL_CLASS}>Unit ₹</span>
            <input
              type="number"
              min={0}
              step={1}
              required
              className={`${INPUT_CLASS} w-full`}
              value={unitPriceInr}
              onChange={(event) => setUnitPriceInr(event.target.value)}
              placeholder="0"
            />
          </label>
          <button
            type="submit"
            disabled={addLineItemMutation.isPending || idToken === null}
            className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
          >
            {addLineItemMutation.isPending ? "Adding…" : "Add line"}
          </button>
          {addLineItemMutation.isError && (
            <p role="alert" className="basis-full text-sm text-rose-800">
              {addLineItemMutation.error instanceof Error
                ? addLineItemMutation.error.message
                : "Could not add line item"}
            </p>
          )}
        </form>
      )}
      <div className={`${CARD_CLASS} overflow-x-auto`}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="mrz border-b border-line bg-mist text-[10px] text-ink-soft">
              <th className="px-4 py-2.5 font-medium">Invoice</th>
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
                <td colSpan={6} className="px-4 py-2.5 text-ink-soft">
                  No line items on this case.
                </td>
              </tr>
            ) : (
              caseRecord.lineItems.map((lineItem, lineIndex) => (
                <tr
                  key={`${lineItem.code}-${lineIndex}`}
                  data-testid="case-line-item-row"
                  className="border-t border-line"
                >
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Include ${lineItem.label} on invoice`}
                      checked={selectedLineIndexes.includes(lineIndex)}
                      onChange={(changeEvent) =>
                        toggleLineSelection(lineIndex, changeEvent.target.checked)
                      }
                    />
                  </td>
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
              <td colSpan={5} className={`${FIELD_LABEL_CLASS} px-4 py-2.5`}>
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
