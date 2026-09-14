import { crm } from "@rgs/shared";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
} from "../labels";

/**
 * The four state axes as Notion property chips (spec §3). The tint mapping is
 * PRINCIPLED, not per-value taste, and each rule is written next to the values
 * it governs so a fifth value added later has an obvious home.
 */
const LAVENDER = "bg-crm-lavender text-crm-charcoal";
const MINT = "bg-crm-mint text-crm-charcoal";
const ROSE = "bg-crm-rose text-crm-charcoal";
const PEACH = "bg-crm-peach text-crm-charcoal";
const YELLOW = "bg-crm-yellow text-crm-charcoal";
const STEEL = "bg-crm-surface text-crm-steel";

/** live → lavender; decided → mint; abandoned → rose; inert → steel. */
const CASE_STATUS_TINTS: Record<crm.CaseStatus, string> = {
  NEW: LAVENDER,
  IN_PROGRESS: LAVENDER,
  APPOINTMENT_SET: LAVENDER,
  SUBMITTED: LAVENDER,
  DECIDED: MINT,
  NOT_SUBMITTED: ROSE,
  WITHDRAWN: ROSE,
  DUPLICATE: ROSE,
  CLOSED: STEEL,
};

/** RGS holds something → peach; in motion → yellow; settled → mint; nothing held → steel. */
const CUSTODY_TINTS: Record<crm.CustodyStatus, string> = {
  WITH_RGS: PEACH,
  AT_EMBASSY: PEACH,
  IN_TRANSIT: YELLOW,
  RETURNED: MINT,
  NOT_HELD: STEEL,
};

/** good → mint; bad → rose; needs action → yellow; waiting → steel. */
const OUTCOME_TINTS: Record<crm.ApplicantOutcome, string> = {
  APPROVED: MINT,
  REJECTED: ROSE,
  SENT_BACK: YELLOW,
  PENDING: STEEL,
};

/** paid → mint; owed → yellow; partial → peach; written off → rose; unbilled → steel. */
const BILLING_TINTS: Record<crm.BillingStatus, string> = {
  PAID: MINT,
  BILL_SENT: YELLOW,
  PART_PAID: PEACH,
  WRITTEN_OFF: ROSE,
  UNBILLED: STEEL,
  UNKNOWN: STEEL,
};

/**
 * UNKNOWN is not a state the business chose -- it is what the importer wrote
 * when it could not read the sheet (spec §3). Making data debt visibly
 * different from a real value is the point: those rows should look unresolved,
 * because seven questions are open with RGS about exactly them.
 */
const DATA_DEBT_BORDER = "border border-dashed border-crm-steel";
const SOLID_BORDER = "border border-transparent";

type AnyAxisChipProps =
  | { axis: "caseStatus"; value: crm.CaseStatus }
  | { axis: "custody"; value: crm.CustodyStatus }
  | { axis: "outcome"; value: crm.ApplicantOutcome }
  | { axis: "billing"; value: crm.BillingStatus };

export function AxisChip(props: AnyAxisChipProps) {
  const { label, tint, isDataDebt } = describeChip(props);
  return (
    <span
      className={`inline-flex h-5 items-center rounded-crm-chip px-1.5 text-[12px] leading-none ${tint} ${
        isDataDebt ? DATA_DEBT_BORDER : SOLID_BORDER
      }`}
      {...(isDataDebt
        ? { title: "The import could not read a billing state for this case" }
        : {})}
    >
      {label}
    </span>
  );
}

function describeChip(props: AnyAxisChipProps): {
  label: string;
  tint: string;
  isDataDebt: boolean;
} {
  switch (props.axis) {
    case "caseStatus":
      return {
        label: CASE_STATUS_LABELS[props.value],
        tint: CASE_STATUS_TINTS[props.value],
        isDataDebt: false,
      };
    case "custody":
      return {
        label: CUSTODY_LABELS[props.value],
        tint: CUSTODY_TINTS[props.value],
        isDataDebt: false,
      };
    case "outcome":
      return {
        label: OUTCOME_LABELS[props.value],
        tint: OUTCOME_TINTS[props.value],
        isDataDebt: false,
      };
    case "billing":
      return {
        label: BILLING_LABELS[props.value],
        tint: BILLING_TINTS[props.value],
        isDataDebt: props.value === "UNKNOWN",
      };
  }
}
