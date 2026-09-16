import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { describeFirstZodIssue } from "../../lib/storedRecords";
import { readCaseRefReservation } from "./caseRefIndex";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { reviewQueueGsi1Pk } from "./keys";
import { getPartnerOrThrow } from "./partners";
import { resolveReviewItem } from "./reviewQueue";

/**
 * The review queue seen by RAW VALUE rather than by item.
 *
 * 851 "partner not recognised" items are a few dozen distinct spellings, each
 * repeated across every case that partner sent. A reviewer decides once per
 * spelling; this module is that once. Items are grouped on the exact
 * (reason, workbook column, raw text) triple -- never on a normalised form,
 * because "GALAXY" and "Galaxy Travels" may well be two partners, and the
 * reviewer, not this code, says which.
 */

const REVIEW_GROUP_PROJECTION: readonly string[] = [
  "PK",
  "SK",
  "reviewItemId",
  "caseRef",
  "reason",
  "fieldName",
  "rawValue",
  "proposedValue",
];

const ReviewGroupRowSchema = crm.ReviewItemSchema.pick({
  reviewItemId: true,
  caseRef: true,
  reason: true,
  fieldName: true,
  rawValue: true,
  proposedValue: true,
});
type ReviewGroupRow = ReturnType<typeof ReviewGroupRowSchema.parse>;

const SAMPLE_CASE_REF_COUNT = 5;

export interface ReviewGroup {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  itemCount: number;
  /** The first suggestion the importer attached to any item in the group. */
  proposedValue?: string;
  sampleCaseRefs: string[];
}

export interface ReviewGroupListing {
  groups: ReviewGroup[];
  unreadableReviewItemIds: string[];
}

function groupKey(reason: string, fieldName: string, rawValue: string): string {
  return JSON.stringify([reason, fieldName, rawValue]);
}

async function sweepOpenReviewRows(
  context: AppContext,
  tenantId: string,
): Promise<{ rows: ReviewGroupRow[]; unreadableReviewItemIds: string[] }> {
  const storedItems = await context.table.queryGsi("GSI1", reviewQueueGsi1Pk(tenantId, "OPEN"), {
    scanForward: true,
    projection: REVIEW_GROUP_PROJECTION,
  });
  const rows: ReviewGroupRow[] = [];
  const unreadableReviewItemIds: string[] = [];
  for (const storedItem of storedItems) {
    const parsedRow = ReviewGroupRowSchema.safeParse(storedItem);
    if (!parsedRow.success) {
      const rawReviewItemId = storedItem["reviewItemId"];
      unreadableReviewItemIds.push(
        typeof rawReviewItemId === "string" && rawReviewItemId.length > 0 ? rawReviewItemId : storedItem.PK,
      );
      continue;
    }
    rows.push(parsedRow.data);
  }
  return { rows, unreadableReviewItemIds };
}

export async function listOpenReviewGroups(
  context: AppContext,
  tenantId: string,
): Promise<ReviewGroupListing> {
  const { rows, unreadableReviewItemIds } = await sweepOpenReviewRows(context, tenantId);
  const groupsByKey = new Map<string, ReviewGroup>();
  for (const row of rows) {
    const key = groupKey(row.reason, row.fieldName, row.rawValue);
    const group = groupsByKey.get(key) ?? {
      reason: row.reason,
      fieldName: row.fieldName,
      rawValue: row.rawValue,
      itemCount: 0,
      sampleCaseRefs: [],
    };
    group.itemCount += 1;
    if (group.proposedValue === undefined && row.proposedValue !== undefined) {
      group.proposedValue = row.proposedValue;
    }
    if (group.sampleCaseRefs.length < SAMPLE_CASE_REF_COUNT && !group.sampleCaseRefs.includes(row.caseRef)) {
      group.sampleCaseRefs.push(row.caseRef);
    }
    groupsByKey.set(key, group);
  }
  const groups = [...groupsByKey.values()].sort(
    (left, right) => right.itemCount - left.itemCount || left.rawValue.localeCompare(right.rawValue),
  );
  return { groups, unreadableReviewItemIds };
}

export interface ResolveReviewGroupInput {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  reviewStatus: "APPLIED" | "DISMISSED";
  /** Required when APPLIED: the value every case in the group should now hold. */
  resolvedValue?: string;
  /** How many items to close in this call; the caller loops on `remainingCount`. */
  limit: number;
}

export interface ReviewGroupResolutionFailure {
  reviewItemId: string;
  caseRef: string;
  message: string;
}

export interface ReviewGroupResolution {
  /** Open items in the group when the call started. */
  matchedCount: number;
  /** Items closed by this call. */
  resolvedCount: number;
  /** Of those, how many rewrote a case. */
  appliedCount: number;
  /** Open items still in the group after this call, failures included. */
  remainingCount: number;
  /** Items left OPEN because their case could not be rewritten. */
  failures: ReviewGroupResolutionFailure[];
}

/** Which workbook date column writes which case field. Mirrors mapRow.ts. */
const DATE_FIELD_BY_COLUMN: Record<string, "receivedDate" | "submissionDate" | "expectedCollectionDate"> = {
  C: "receivedDate",
  "Sub Date": "submissionDate",
  Collection: "expectedCollectionDate",
};

/**
 * Checks the resolved value against what the reason will write, BEFORE the
 * first case is touched: a bad value must fail the whole group as a 400, not
 * fail the first item and leave the reviewer with a half-applied group.
 */
async function validateResolvedValue(
  context: AppContext,
  tenantId: string,
  input: ResolveReviewGroupInput,
): Promise<void> {
  if (input.reviewStatus === "DISMISSED") return;
  if (!crm.isAppliableReviewReason(input.reason)) {
    throw badRequest(`${input.reason} items carry nothing to apply to a case; dismiss them instead`);
  }
  const resolvedValue = input.resolvedValue;
  if (resolvedValue === undefined || resolvedValue === "") {
    throw badRequest("Applying a group needs the value the cases should hold");
  }
  switch (input.reason) {
    case "UNMAPPED_PARTNER":
      await getPartnerOrThrow(context, tenantId, resolvedValue);
      return;
    case "UNMAPPED_COUNTRY":
      if (!/^[A-Z]{2}$/.test(resolvedValue)) throw badRequest("A country is its two-letter ISO code");
      return;
    case "UNPARSEABLE_DATE":
      if (DATE_FIELD_BY_COLUMN[input.fieldName] === undefined) {
        throw badRequest(`The "${input.fieldName}" column is not a date the case stores`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedValue)) throw badRequest("A date is YYYY-MM-DD");
      return;
    case "UNMAPPED_STATUS":
      if (!crm.CASE_STATUSES.includes(resolvedValue as crm.CaseStatus)) {
        throw badRequest(`Unknown case status ${resolvedValue}`);
      }
      return;
    case "UNMAPPED_VISA_TYPE":
      if (!crm.VISA_TYPES.includes(resolvedValue as crm.VisaType)) {
        throw badRequest(`Unknown visa type ${resolvedValue}`);
      }
      return;
    case "UNMAPPED_ENTRIES":
      if (!crm.ENTRY_TYPES.includes(resolvedValue as crm.EntryType)) {
        throw badRequest(`Unknown entry type ${resolvedValue}`);
      }
      return;
    default:
      throw badRequest(`${input.reason} items cannot be applied`);
  }
}

/**
 * Writes the resolved value onto one case. Direct field writes, not the
 * per-axis state machines: the case never held the right value -- the sheet
 * said something the importer could not read -- so this is a correction of
 * the import, and it is recorded on the timeline as exactly that.
 */
async function applyResolvedValueToCase(
  context: AppContext,
  tenantId: string,
  row: ReviewGroupRow,
  input: ResolveReviewGroupInput,
  resolvedValue: string,
  actorEmail: string,
): Promise<void> {
  const reservation = await readCaseRefReservation(context, tenantId, row.caseRef);
  if (reservation === undefined) {
    throw badRequest(`No case is filed under REF ${row.caseRef}`);
  }
  const currentCase = await readCaseOrThrow(context, tenantId, reservation.caseId);

  let changedField: string;
  let patch: Partial<crm.CrmCase>;
  switch (input.reason) {
    case "UNMAPPED_PARTNER":
      changedField = "partnerId";
      patch = { partnerId: resolvedValue };
      break;
    case "UNMAPPED_COUNTRY":
      changedField = "destinationCountry";
      patch = { destinationCountry: resolvedValue };
      break;
    case "UNPARSEABLE_DATE":
      changedField = DATE_FIELD_BY_COLUMN[input.fieldName]!;
      patch = { [changedField]: resolvedValue };
      break;
    case "UNMAPPED_STATUS":
      changedField = "caseStatus";
      patch = { caseStatus: resolvedValue as crm.CaseStatus };
      break;
    case "UNMAPPED_VISA_TYPE":
      changedField = "visaType";
      patch = { visaType: resolvedValue as crm.VisaType };
      break;
    case "UNMAPPED_ENTRIES":
      changedField = "entryType";
      patch = { entryType: resolvedValue as crm.EntryType };
      break;
    default:
      throw badRequest(`${input.reason} items cannot be applied`);
  }

  let updatedCase: crm.CrmCase;
  try {
    updatedCase = crm.CrmCaseSchema.parse({
      ...currentCase,
      ...patch,
      updatedAt: context.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ZodError) throw badRequest(describeFirstZodIssue(error));
    throw error;
  }

  await writeCase(context, updatedCase);
  await recordCrmEvent(
    context,
    tenantId,
    updatedCase.caseId,
    input.reason === "UNMAPPED_STATUS" ? "CASE_STATUS_CHANGED" : "CASE_UPDATED",
    actorEmail,
    input.reason === "UNMAPPED_STATUS"
      ? { fromStatus: currentCase.caseStatus, toStatus: resolvedValue, source: "import review" }
      : { changedFields: changedField, source: "import review", sheetSaid: row.rawValue },
  );
}

/**
 * Closes up to `limit` open items in one raw-value group, rewriting each
 * item's case first when the resolution is APPLIED.
 *
 * Chunked because the Lambda has 15 seconds and the largest group has several
 * hundred cases: the caller reads `remainingCount` and calls again. A case
 * that cannot be rewritten leaves its item OPEN and is named in `failures`
 * rather than being dismissed with the rest -- an item closed over a case
 * that still holds the wrong value is the one outcome this must never
 * produce.
 */
export async function resolveReviewGroup(
  context: AppContext,
  tenantId: string,
  input: ResolveReviewGroupInput,
  actorEmail: string,
): Promise<ReviewGroupResolution> {
  await validateResolvedValue(context, tenantId, input);

  const { rows } = await sweepOpenReviewRows(context, tenantId);
  const matchingRows = rows.filter(
    (row) => row.reason === input.reason && row.fieldName === input.fieldName && row.rawValue === input.rawValue,
  );
  const rowsThisCall = matchingRows.slice(0, input.limit);

  const failures: ReviewGroupResolutionFailure[] = [];
  let resolvedCount = 0;
  let appliedCount = 0;
  for (const row of rowsThisCall) {
    try {
      if (input.reviewStatus === "APPLIED") {
        await applyResolvedValueToCase(context, tenantId, row, input, input.resolvedValue!, actorEmail);
        appliedCount += 1;
      }
      await resolveReviewItem(
        context,
        tenantId,
        row.reviewItemId,
        {
          reviewStatus: input.reviewStatus,
          ...(input.resolvedValue !== undefined && input.resolvedValue !== ""
            ? { resolvedValue: input.resolvedValue }
            : {}),
        },
        actorEmail,
      );
      resolvedCount += 1;
    } catch (error) {
      failures.push({
        reviewItemId: row.reviewItemId,
        caseRef: row.caseRef,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    matchedCount: matchingRows.length,
    resolvedCount,
    appliedCount,
    remainingCount: matchingRows.length - resolvedCount,
    failures,
  };
}
