import { crm } from "@rgs/shared";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
} from "../labels";

/**
 * The four state axes as coloured pills, the same shape the Queue page gives
 * a payment status. The hue is chosen by what a desk agent needs to see at a
 * glance, and each rule is written next to the values it governs so a value
 * added later has an obvious home.
 *
 * Every family is Tailwind's own `-100` background with its `-900` text, so
 * contrast is the same across the board.
 */
const SKY = "bg-sky-100 text-sky-900";
const AMBER = "bg-amber-100 text-amber-900";
const VIOLET = "bg-violet-100 text-violet-900";
const BLUE = "bg-blue-100 text-blue-900";
const EMERALD = "bg-emerald-100 text-emerald-900";
const ORANGE = "bg-orange-100 text-orange-900";
const ROSE = "bg-rose-100 text-rose-900";
const NEUTRAL = "bg-zinc-100 text-zinc-700";
/** Import debt: not a value anyone chose. Amber says "look at this", the dashed rule says "unresolved". */
const ATTENTION = "bg-amber-50 text-amber-900";

/** fresh → sky; being worked → amber; scheduled → violet; filed → blue; decided → emerald; abandoned → rose; inert → neutral. */
export const CASE_STATUS_TINTS: Record<crm.CaseStatus, string> = {
  NEW: SKY,
  IN_PROGRESS: AMBER,
  APPOINTMENT_SET: VIOLET,
  SUBMITTED: BLUE,
  DECIDED: EMERALD,
  NOT_SUBMITTED: ROSE,
  WITHDRAWN: ROSE,
  DUPLICATE: NEUTRAL,
  CLOSED: NEUTRAL,
};

/** RGS holds it → orange; the embassy holds it → violet; in motion → amber; back with the traveller → emerald; nothing held → neutral. */
export const CUSTODY_TINTS: Record<crm.CustodyStatus, string> = {
  WITH_RGS: ORANGE,
  AT_EMBASSY: VIOLET,
  IN_TRANSIT: AMBER,
  RETURNED: EMERALD,
  NOT_HELD: NEUTRAL,
};

/** good → emerald; bad → rose; needs another go → amber; waiting → neutral. */
export const OUTCOME_TINTS: Record<crm.ApplicantOutcome, string> = {
  APPROVED: EMERALD,
  REJECTED: ROSE,
  SENT_BACK: AMBER,
  PENDING: NEUTRAL,
};

/** paid → emerald; owed → amber; partly paid → orange; written off → rose; not yet billed → neutral; unreadable → attention. */
export const BILLING_TINTS: Record<crm.BillingStatus, string> = {
  PAID: EMERALD,
  BILL_SENT: AMBER,
  PART_PAID: ORANGE,
  WRITTEN_OFF: ROSE,
  UNBILLED: NEUTRAL,
  UNKNOWN: ATTENTION,
};

/**
 * UNKNOWN is not a state the business chose -- it is what the importer wrote
 * when it could not read the sheet. Making data debt visibly different from a
 * real value is the point: those rows should look unresolved.
 */
const DATA_DEBT_BORDER = "border border-dashed border-amber-500";
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
      className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-semibold leading-none ${tint} ${
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
