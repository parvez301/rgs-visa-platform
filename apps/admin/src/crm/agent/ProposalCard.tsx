import { useState } from "react";
import { crm } from "@rgs/shared";
import type { ProposalView } from "../api/crmClient";
import {
  BILLING_LABELS,
  CASE_FIELD_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  ENTRY_TYPE_LABELS,
  LINE_ITEM_KIND_LABELS,
  OUTCOME_LABELS,
  PROCESSING_LABELS,
  PROPOSAL_TOOL_LABELS,
  VISA_TYPE_LABELS,
  describeEnumValue,
} from "../labels";

/** R61: the discard route's `reason` is a required, trimmed, non-empty string. */
export const DEFAULT_DISCARD_REASON = "Discarded from the agent panel";

/**
 * The value `update_case` writes into a summary's `from` when the case had no
 * value for that field yet (`NOT_SET_FROM`, writeTools.ts). Rendered as a
 * dash rather than passed through the enum label maps, which would name it "an
 * unrecognised value".
 */
const NOT_SET_FROM = "(not set)";

/**
 * Which label map reads a given summary row's values.
 *
 * Keyed on the LAST dotted segment of `field`, because a per-applicant axis
 * arrives as `applicants.A1.custody` (writeTools.ts's `setCustodyTool`) while a
 * case-level one arrives as `billingStatus`. A field with no entry here is not
 * an enum at all (a date, an amount, a free-text note) and is rendered as it
 * stands.
 */
const SUMMARY_VALUE_LABELS: Record<string, Readonly<Record<string, string>>> = {
  custody: CUSTODY_LABELS,
  billingStatus: BILLING_LABELS,
  caseStatus: CASE_STATUS_LABELS,
  outcome: OUTCOME_LABELS,
  visaType: VISA_TYPE_LABELS,
  entryType: ENTRY_TYPE_LABELS,
  processing: PROCESSING_LABELS,
  kind: LINE_ITEM_KIND_LABELS,
};

function lastFieldSegment(field: string): string {
  const segments = field.split(".");
  return segments[segments.length - 1] ?? field;
}

/** The field's own name, as a sentence uses it. */
export function describeProposalField(field: string): string {
  const fieldSegment = lastFieldSegment(field);
  const caseFieldLabel = CASE_FIELD_LABELS[fieldSegment];
  if (caseFieldLabel !== undefined) return caseFieldLabel;
  const enumFieldLabels: Record<string, string> = {
    custody: "custody",
    billingStatus: "billing status",
    caseStatus: "case status",
    outcome: "outcome",
    applicants: "applicants",
    lineItems: "line items",
    kind: "line item kind",
    amountInr: "amount",
    text: "text",
  };
  return enumFieldLabels[fieldSegment] ?? fieldSegment;
}

/** One side of a summary row, never a raw enum. */
export function describeProposalValue(field: string, rawValue: string): string {
  if (rawValue === NOT_SET_FROM || rawValue === "") return "—";
  const valueLabels = SUMMARY_VALUE_LABELS[lastFieldSegment(field)];
  if (valueLabels === undefined) return rawValue;
  return describeEnumValue(rawValue, valueLabels);
}

/**
 * The enum input fields a human may edit before approving, keyed by the name
 * the tool's own Zod schema uses (writeTools.ts).
 *
 * The FULL enum is offered, not the state machine's currently-legal slice. The
 * `from` on a summary row is a snapshot taken when the proposal was STAGED,
 * which may be minutes or days before anybody clicks Approve -- filtering the
 * dropdown against a stale `from` can hide the only move that is now legal,
 * which is worse than offering one the server refuses with a 409 this card
 * already reports per item.
 */
const EDITABLE_ENUM_INPUTS: Record<
  string,
  { label: string; values: readonly string[]; valueLabels: Readonly<Record<string, string>> }
> = {
  custody: { label: "Custody", values: crm.CUSTODY_STATUSES, valueLabels: CUSTODY_LABELS },
  billingStatus: { label: "Billing status", values: crm.BILLING_STATUSES, valueLabels: BILLING_LABELS },
  caseStatus: { label: "Case status", values: crm.CASE_STATUSES, valueLabels: CASE_STATUS_LABELS },
  outcome: { label: "Outcome", values: crm.APPLICANT_OUTCOMES, valueLabels: OUTCOME_LABELS },
  visaType: { label: "Visa type", values: crm.VISA_TYPES, valueLabels: VISA_TYPE_LABELS },
  entryType: { label: "Entry type", values: crm.ENTRY_TYPES, valueLabels: ENTRY_TYPE_LABELS },
  processing: { label: "Processing speed", values: crm.PROCESSING_SPEEDS, valueLabels: PROCESSING_LABELS },
};

/**
 * A change that has actually been written, and the input that wrote it.
 *
 * `effectiveInput` is the whole tool input as it went to the server -- the
 * staged input when nobody edited it, the merged input when somebody did, and
 * (for an auto-applied change) the proposal's own input. Everything downstream
 * of the write reads THIS and never `summary[].to`, because a summary row is a
 * snapshot of what the model staged and an edited approval writes something
 * else.
 */
export interface AppliedChange {
  proposalId: string;
  toolName: string;
  caseId: string | undefined;
  effectiveInput: Record<string, unknown>;
  summary: ProposalView["summary"];
  /** True when the trust ladder applied it without anybody clicking Approve. */
  autoApplied: boolean;
}

export function appliedChangeFrom(
  proposal: ProposalView,
  effectiveInput: Record<string, unknown>,
  autoApplied: boolean,
): AppliedChange {
  return {
    proposalId: proposal.proposalId,
    toolName: proposal.toolName,
    caseId: proposal.caseId,
    effectiveInput,
    summary: proposal.summary,
    autoApplied,
  };
}

/**
 * Whether an applied change can be walked back through a route the admin
 * client already has.
 *
 * There is NO un-approve endpoint: `applyApprovedChange` is one-way and the
 * PROPOSAL_APPROVED event stands whatever happens next. What can sometimes be
 * done is the same thing a desk agent would do by hand -- move the axis back
 * through the case's own REST route -- and only when the state machine allows
 * that edge. Anything else says so instead of showing a button that cannot
 * work.
 */
export function canReverseApproval(appliedChange: AppliedChange): boolean {
  const reversal = readSingleAxisReversal(appliedChange);
  return reversal !== undefined;
}

/**
 * The one axis move that would put an applied change back, already narrowed to
 * the enum the matching client method takes -- so no caller has to cast a
 * string back into a `CustodyStatus` and be wrong about it.
 *
 * The axis the case is at NOW comes from `effectiveInput`, not from the staged
 * `summary[0].to`: for both `set_custody` and `set_billing` the tool's own
 * input field is named exactly like the summary row's last segment
 * (`{ caseId, applicantRef, custody }` and `{ caseId, billingStatus }`,
 * writeTools.ts), which is why one lookup serves both. `from` still comes from
 * the summary, because it is the only record of where the case was before the
 * write and an edit never changes it.
 */
export type ApprovalReversal =
  | { axis: "custody"; caseId: string; applicantRef: string; toCustody: crm.CustodyStatus }
  | { axis: "billingStatus"; caseId: string; toBillingStatus: crm.BillingStatus };

export function readSingleAxisReversal(appliedChange: AppliedChange): ApprovalReversal | undefined {
  if (appliedChange.caseId === undefined) return undefined;
  if (appliedChange.summary.length !== 1) return undefined;
  const summaryRow = appliedChange.summary[0];
  if (summaryRow === undefined) return undefined;
  const axisSegment = lastFieldSegment(summaryRow.field);
  const writtenValue = appliedChange.effectiveInput[axisSegment];
  if (typeof writtenValue !== "string") return undefined;

  if (appliedChange.toolName === "set_custody" && axisSegment === "custody") {
    const fromCustody = asMember(summaryRow.from, crm.CUSTODY_STATUSES);
    const writtenCustody = asMember(writtenValue, crm.CUSTODY_STATUSES);
    if (fromCustody === undefined || writtenCustody === undefined) return undefined;
    if (!crm.canTransitionCustody(writtenCustody, fromCustody)) return undefined;
    const applicantRef = appliedChange.effectiveInput["applicantRef"];
    if (typeof applicantRef !== "string" || applicantRef === "") return undefined;
    return { axis: "custody", caseId: appliedChange.caseId, applicantRef, toCustody: fromCustody };
  }

  if (appliedChange.toolName === "set_billing" && axisSegment === "billingStatus") {
    const fromBilling = asMember(summaryRow.from, crm.BILLING_STATUSES);
    const writtenBilling = asMember(writtenValue, crm.BILLING_STATUSES);
    if (fromBilling === undefined || writtenBilling === undefined) return undefined;
    if (!crm.canTransitionBilling(writtenBilling, fromBilling)) return undefined;
    return { axis: "billingStatus", caseId: appliedChange.caseId, toBillingStatus: fromBilling };
  }

  return undefined;
}

function asMember<MemberType extends string>(
  candidate: string,
  members: readonly MemberType[],
): MemberType | undefined {
  return (members as readonly string[]).includes(candidate) ? (candidate as MemberType) : undefined;
}

function describeWriteFailure(writeError: unknown, fallbackMessage: string): string {
  if (writeError instanceof Error && writeError.message.length > 0) return writeError.message;
  return fallbackMessage;
}

interface ApprovalOutcome {
  appliedCount: number;
  failuresByProposalId: Record<string, string>;
}

export interface ProposalCardProps {
  proposals: ProposalView[];
  /**
   * Changes the turn applied on its own (R72). They were never pending here,
   * so the card cannot know their effective input by watching an approval --
   * the panel hands them over already applied, and they get the same
   * undo-or-say-so treatment as an approval.
   */
  autoAppliedChanges?: AppliedChange[];
  onApprove?(proposalId: string, editedInput?: Record<string, unknown>): Promise<unknown>;
  onDiscard?(proposalId: string, reason: string): Promise<unknown>;
  /** Supplied by the panel; the card decides per change whether it is offered at all. */
  onUndoApproval?(appliedChange: AppliedChange): Promise<unknown>;
}

const CARD_CONTROL_CLASS =
  "rounded-crm-control border border-crm-rule-box bg-crm-canvas px-2 py-1 text-[13px] text-crm-charcoal disabled:opacity-60";

/**
 * One card for everything the agent staged on a turn (spec §6's four AX
 * patterns: Intent Handshake, Generative Momentum, Escape Hatch, and the
 * honesty rules around what a write actually did).
 *
 * N proposals, ONE card, and N approve calls: the backend has no bulk write
 * tool, and each case keeping its own PROPOSAL_APPROVED event is the better
 * audit trail for a business billing real clients.
 *
 * `--crm-primary` appears exactly once in this file, on Approve. It is the
 * only purple control in the product.
 */
export function ProposalCard({
  proposals,
  autoAppliedChanges = [],
  onApprove,
  onDiscard,
  onUndoApproval,
}: ProposalCardProps) {
  const [approvedChanges, setApprovedChanges] = useState<AppliedChange[]>([]);
  const [discardedProposalIds, setDiscardedProposalIds] = useState<string[]>([]);
  const [editingProposalIds, setEditingProposalIds] = useState<string[]>([]);
  const [editedValuesByProposalId, setEditedValuesByProposalId] = useState<
    Record<string, Record<string, string>>
  >({});
  const [discardReasonsByProposalId, setDiscardReasonsByProposalId] = useState<Record<string, string>>({});
  const [discardingProposalIds, setDiscardingProposalIds] = useState<string[]>([]);
  const [discardFailuresByProposalId, setDiscardFailuresByProposalId] = useState<Record<string, string>>({});
  const [approvalOutcome, setApprovalOutcome] = useState<ApprovalOutcome | undefined>(undefined);
  const [isApproving, setIsApproving] = useState(false);
  const [undoneProposalIds, setUndoneProposalIds] = useState<string[]>([]);
  const [undoFailuresByProposalId, setUndoFailuresByProposalId] = useState<Record<string, string>>({});

  const settledProposalIds = new Set([
    ...approvedChanges.map((appliedChange) => appliedChange.proposalId),
    ...discardedProposalIds,
  ]);
  const pendingProposals = proposals.filter(
    (proposal) => !settledProposalIds.has(proposal.proposalId),
  );
  // Auto-applied first: they were written before anybody looked at this card.
  const appliedChanges = [...autoAppliedChanges, ...approvedChanges];

  /**
   * `undefined` whenever the human changed nothing, even if they opened the
   * editor: the approve route reads `editedInput === undefined` to decide
   * whether this approval counts toward `confirmedWithoutEditCount`, and an
   * echoed-back input would starve the only signal the trust ladder advances
   * on.
   */
  function editedInputFor(proposal: ProposalView): Record<string, unknown> | undefined {
    const editedValues = editedValuesByProposalId[proposal.proposalId];
    if (editedValues === undefined) return undefined;
    const changedEntries = Object.entries(editedValues).filter(
      ([inputKey, editedValue]) => proposal.input[inputKey] !== editedValue,
    );
    if (changedEntries.length === 0) return undefined;
    return { ...proposal.input, ...Object.fromEntries(changedEntries) };
  }

  /** What the server will actually be given -- an edit if there is one, the staged input otherwise. */
  function effectiveInputFor(proposal: ProposalView): Record<string, unknown> {
    return editedInputFor(proposal) ?? proposal.input;
  }

  /**
   * The `to` this row plays back: the human's edit while it stands, the staged
   * value otherwise. Without this the card shows one change and Approve writes
   * another (spec §6's Intent Handshake is a promise about the write, not
   * about the proposal).
   */
  function playedBackTo(proposal: ProposalView, summaryRow: ProposalView["summary"][number]): string {
    const editedValue = editedValuesByProposalId[proposal.proposalId]?.[lastFieldSegment(summaryRow.field)];
    return editedValue ?? summaryRow.to;
  }

  async function approveEveryPendingProposal() {
    if (onApprove === undefined || pendingProposals.length === 0) return;
    setIsApproving(true);
    const proposalsToApprove = [...pendingProposals];
    const newlyApplied: AppliedChange[] = [];
    const failuresByProposalId: Record<string, string> = {};

    // Sequential, not `Promise.all`: each approval is a real write against a
    // real case, and a per-item outcome is only honest if each item's result
    // is the one that came back for it.
    for (const proposal of proposalsToApprove) {
      try {
        await onApprove(proposal.proposalId, editedInputFor(proposal));
        // The EFFECTIVE input, not the proposal: an edited approval moves the
        // case somewhere the staged summary never mentions, and every later
        // question about this change ("can it be undone, and to what?") has to
        // be asked of what was written.
        newlyApplied.push(appliedChangeFrom(proposal, effectiveInputFor(proposal), false));
      } catch (approvalError) {
        failuresByProposalId[proposal.proposalId] = describeWriteFailure(
          approvalError,
          "The change could not be applied.",
        );
      }
    }

    setApprovedChanges((currentApplied) => [...currentApplied, ...newlyApplied]);
    setApprovalOutcome({ appliedCount: newlyApplied.length, failuresByProposalId });
    setIsApproving(false);
  }

  async function discardProposal(proposal: ProposalView) {
    if (onDiscard === undefined) return;
    const typedReason = (discardReasonsByProposalId[proposal.proposalId] ?? "").trim();
    setDiscardingProposalIds((current) => [...current, proposal.proposalId]);
    setDiscardFailuresByProposalId((current) => {
      const { [proposal.proposalId]: _clearedFailure, ...remaining } = current;
      return remaining;
    });
    try {
      await onDiscard(proposal.proposalId, typedReason === "" ? DEFAULT_DISCARD_REASON : typedReason);
      setDiscardedProposalIds((current) => [...current, proposal.proposalId]);
    } catch (discardError) {
      // The proposal is still staged on the server, so it stays on screen with
      // the server's own words -- exactly as a failed approval does. Without
      // this the click did nothing visible AND left an unhandled rejection
      // behind (`void discardProposal(...)`).
      setDiscardFailuresByProposalId((current) => ({
        ...current,
        [proposal.proposalId]: describeWriteFailure(discardError, "The proposal could not be discarded."),
      }));
    } finally {
      setDiscardingProposalIds((current) =>
        current.filter((proposalId) => proposalId !== proposal.proposalId),
      );
    }
  }

  async function undoApproval(appliedChange: AppliedChange) {
    if (onUndoApproval === undefined) return;
    try {
      await onUndoApproval(appliedChange);
      setUndoneProposalIds((current) => [...current, appliedChange.proposalId]);
    } catch (undoError) {
      setUndoFailuresByProposalId((current) => ({
        ...current,
        [appliedChange.proposalId]: describeWriteFailure(undoError, "The change could not be undone."),
      }));
    }
  }

  if (pendingProposals.length === 0 && appliedChanges.length === 0 && discardedProposalIds.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Proposed changes"
      className="rounded-crm-card border border-crm-rule-box bg-crm-canvas p-3 text-[14px] leading-[1.45] text-crm-charcoal"
    >
      <h3 className="text-[13px] font-medium">
        {pendingProposals.length > 0
          ? pendingProposals.length === 1
            ? "The agent proposes one change"
            : `The agent proposes ${pendingProposals.length} changes`
          : describeSettledHeading(appliedChanges.length, discardedProposalIds.length)}
      </h3>
      <p className="mt-1 text-[13px] text-crm-steel">
        {pendingProposals.length > 0
          ? "Nothing below has been written yet. Approve applies it; Discard throws it away."
          : appliedChanges.length > 0
            ? "Nothing is left waiting for you on this turn."
            : "Nothing was written."}
      </p>

      <ul className="mt-3 flex flex-col gap-3">
        {pendingProposals.map((proposal) => {
          const isEditing = editingProposalIds.includes(proposal.proposalId);
          const failureMessage = approvalOutcome?.failuresByProposalId[proposal.proposalId];
          const isDiscarding = discardingProposalIds.includes(proposal.proposalId);
          const discardFailureMessage = discardFailuresByProposalId[proposal.proposalId];
          const hasOpenedDiscard = discardReasonsByProposalId[proposal.proposalId] !== undefined;

          return (
            <li
              key={proposal.proposalId}
              data-testid={`proposal-${proposal.proposalId}`}
              className="rounded-crm-badge border border-crm-rule-row p-2"
            >
              <p className="text-[13px] font-medium">
                {describeEnumValue(proposal.toolName, PROPOSAL_TOOL_LABELS)}
              </p>

              <ul
                data-testid={`proposal-diff-${proposal.proposalId}`}
                className="mt-1 flex flex-col gap-0.5 text-[13px]"
              >
                {proposal.summary.map((summaryRow, summaryRowIndex) => (
                  <li key={`${summaryRow.field}-${summaryRowIndex}`} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-crm-steel">{describeProposalField(summaryRow.field)}</span>
                    <span>{describeProposalValue(summaryRow.field, summaryRow.from)}</span>
                    <span aria-hidden="true" className="text-crm-steel">
                      →
                    </span>
                    <span>
                      {describeProposalValue(summaryRow.field, playedBackTo(proposal, summaryRow))}
                    </span>
                  </li>
                ))}
              </ul>

              {isEditing && (
                <div className="mt-2 flex flex-col gap-2">
                  {Object.entries(proposal.input).map(([inputKey, inputValue]) => {
                    const editableInput = EDITABLE_ENUM_INPUTS[inputKey];
                    if (editableInput === undefined) return null;
                    const selectedValue =
                      editedValuesByProposalId[proposal.proposalId]?.[inputKey] ?? String(inputValue);
                    return (
                      <label key={inputKey} className="flex flex-col gap-1 text-[13px] text-crm-steel">
                        {editableInput.label}
                        <select
                          value={selectedValue}
                          onChange={(changeEvent) =>
                            setEditedValuesByProposalId((currentEdits) => ({
                              ...currentEdits,
                              [proposal.proposalId]: {
                                ...currentEdits[proposal.proposalId],
                                [inputKey]: changeEvent.target.value,
                              },
                            }))
                          }
                          className={CARD_CONTROL_CLASS}
                        >
                          {editableInput.values.map((optionValue) => (
                            <option key={optionValue} value={optionValue}>
                              {editableInput.valueLabels[optionValue] ?? optionValue}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              {failureMessage !== undefined && (
                <p role="alert" className="mt-2 text-[13px] text-crm-charcoal">
                  {failureMessage}
                </p>
              )}

              {discardFailureMessage !== undefined && (
                <p role="alert" className="mt-2 text-[13px] text-crm-charcoal">
                  {discardFailureMessage}
                </p>
              )}

              {hasOpenedDiscard && (
                <div className="mt-2 flex flex-col gap-1">
                  <label className="flex flex-col gap-1 text-[13px] text-crm-steel">
                    Why? (optional)
                    <input
                      type="text"
                      value={discardReasonsByProposalId[proposal.proposalId] ?? ""}
                      onChange={(changeEvent) =>
                        setDiscardReasonsByProposalId((currentReasons) => ({
                          ...currentReasons,
                          [proposal.proposalId]: changeEvent.target.value,
                        }))
                      }
                      className={CARD_CONTROL_CLASS}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={isDiscarding}
                    onClick={() => void discardProposal(proposal)}
                    className={`w-fit ${CARD_CONTROL_CLASS}`}
                  >
                    Confirm discard
                  </button>
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setEditingProposalIds((currentIds) =>
                      currentIds.includes(proposal.proposalId)
                        ? currentIds.filter((proposalId) => proposalId !== proposal.proposalId)
                        : [...currentIds, proposal.proposalId],
                    )
                  }
                  className={CARD_CONTROL_CLASS}
                >
                  {isEditing ? "Close editor" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDiscardReasonsByProposalId((currentReasons) => ({
                      ...currentReasons,
                      [proposal.proposalId]: currentReasons[proposal.proposalId] ?? "",
                    }))
                  }
                  className={CARD_CONTROL_CLASS}
                >
                  Discard
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {approvalOutcome !== undefined && (
        <p role="status" className="mt-3 text-[13px]">
          {describeApprovalOutcome(approvalOutcome)}
        </p>
      )}

      {appliedChanges.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[13px]">
          {appliedChanges.map((appliedChange) => {
            const isUndone = undoneProposalIds.includes(appliedChange.proposalId);
            const undoFailure = undoFailuresByProposalId[appliedChange.proposalId];
            const isReversible = onUndoApproval !== undefined && canReverseApproval(appliedChange);
            return (
              <li key={appliedChange.proposalId} className="flex flex-wrap items-center gap-2">
                <span>
                  {describeEnumValue(appliedChange.toolName, PROPOSAL_TOOL_LABELS)}
                  {appliedChange.autoApplied
                    ? " — applied automatically, without waiting for you."
                    : " — applied."}
                </span>
                {isUndone ? (
                  <span className="text-crm-steel">Undone.</span>
                ) : isReversible ? (
                  <button
                    type="button"
                    onClick={() => void undoApproval(appliedChange)}
                    className={CARD_CONTROL_CLASS}
                  >
                    Undo
                  </button>
                ) : (
                  // Honest, not silent: there is no un-approve route, and for
                  // this change there is no legal move back through the case's
                  // own routes either.
                  <span className="text-crm-steel">
                    This cannot be undone from here; change it back on the case if it was wrong.
                  </span>
                )}
                {undoFailure !== undefined && (
                  <span role="alert" className="text-crm-steel">
                    The undo failed: {undoFailure}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pendingProposals.length > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={isApproving}
            onClick={() => void approveEveryPendingProposal()}
            className="rounded-crm-control bg-crm-primary px-3 py-1 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {pendingProposals.length === 1 ? "Approve" : `Approve all ${pendingProposals.length}`}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * What the card calls itself once nothing is pending. It must never keep
 * counting proposals ("proposes 0 changes") over work it has already written,
 * and it must never say nothing was written when something was.
 */
function describeSettledHeading(appliedCount: number, discardedCount: number): string {
  if (appliedCount > 0 && discardedCount > 0) {
    return `${appliedCount} applied, ${discardedCount} discarded`;
  }
  if (appliedCount > 0) {
    return appliedCount === 1 ? "1 change applied" : `${appliedCount} changes applied`;
  }
  return discardedCount === 1 ? "1 change discarded" : `${discardedCount} changes discarded`;
}

function describeApprovalOutcome(outcome: ApprovalOutcome): string {
  const failureCount = Object.keys(outcome.failuresByProposalId).length;
  if (failureCount === 0) {
    return outcome.appliedCount === 1 ? "1 applied." : `${outcome.appliedCount} applied.`;
  }
  // Never "done" and never a single error standing for the whole batch: the
  // desk agent has to know exactly how many of their cases moved.
  return `${outcome.appliedCount} applied, ${failureCount} failed.`;
}
