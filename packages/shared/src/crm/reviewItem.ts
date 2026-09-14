import { z } from "zod";

/** Why a row could not be applied deterministically. Spec §9 pass 3. */
export const REVIEW_REASONS = [
  "UNMAPPED_STATUS",
  "UNMAPPED_ENTRIES",
  "UNMAPPED_VISA_TYPE",
  "UNMAPPED_COUNTRY",
  "UNMAPPED_PARTNER",
  "UNPARSEABLE_DATE",
  "COLUMN_SHIFT_JUNK",
  "SUSPECT_PHONE",
  "PROPOSED_GROUP",
  "DUPLICATE_REF",
  /**
   * The schema requires this field but the sheet did not record one. Distinct
   * from the UNMAPPED_* reasons above: those name a value that was PRESENT
   * but could not be understood; this one names a value that was fabricated
   * because the target schema has no "absent" representation for it (a
   * required field cannot simply stay unset). The fabricated placeholder
   * lands on `proposedValue`; `rawValue` is the empty string the sheet
   * actually held.
   */
  "MISSING_REQUIRED_FIELD",
  /**
   * A row could not be imported because the case already holding its ref is
   * stored in a state nothing can read — or because a previous run reserved
   * the ref and died before writing the case. Unlike every other reason here
   * this one is not about the workbook at all: the spreadsheet cell is fine
   * and the stored record is not, so it names a `caseId` rather than a value.
   */
  "UNREADABLE_STORED_CASE",
  /**
   * The sheet says the money arrived, and the importer refused to act on it.
   *
   * `BILLING_TRANSITIONS` gives `PAID` no exits, `changeBillingStatus` is on
   * the forbidden list for migrated cases, and `isCaseClosable` treats `PAID`
   * as settled — so an import that wrote `PAID` off a free-text spreadsheet
   * cell would lock the case on both axes with nothing in the product able to
   * correct it. The import therefore writes `BILL_SENT`, which has exits, and
   * raises this: `rawValue` is the cell, `proposedValue` is the state an
   * operator should move it to once they have confirmed the receipt.
   *
   * Distinct from UNMAPPED_STATUS on purpose. That one names a value nothing
   * could understand; this one names a value that WAS understood and was
   * deliberately not applied, and the two need different queue filters because
   * they need different work.
   */
  "UNCONFIRMED_PAYMENT",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/**
 * The two reasons that say "this row may be the same work as another row"
 * rather than "this cell could not be read". Spec §7 marks a case carrying one
 * of these differently from a case with a field-level problem, because
 * resolving them is different work: one is a judgement about two cases, the
 * other is a correction to one value.
 */
export const MERGE_REVIEW_REASONS: readonly ReviewReason[] = ["PROPOSED_GROUP", "DUPLICATE_REF"];

export function isMergeReviewReason(reason: ReviewReason): boolean {
  return MERGE_REVIEW_REASONS.includes(reason);
}

export const REVIEW_STATUSES = ["OPEN", "APPLIED", "DISMISSED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ReviewItemSchema = z.object({
  tenantId: z.string().min(1),
  reviewItemId: z.string().min(1),
  reason: z.enum(REVIEW_REASONS),
  reviewStatus: z.enum(REVIEW_STATUSES).default("OPEN"),
  /** Provenance: every item traces back to a workbook cell. Spec §9. */
  sourceSheet: z.string().min(1),
  sourceRow: z.number().int().positive(),
  caseRef: z.string().min(1),
  /** The workbook column this item is about, e.g. "Status". */
  fieldName: z.string().min(1),
  /** Exactly what the sheet said, before any normalization. */
  rawValue: z.string(),
  /** What pass 1 or pass 2 suggests. Absent when nothing could be suggested. */
  proposedValue: z.string().optional(),
  /** Written by Plan 4's pass 2 only. Pass 1 omits it. */
  confidence: z.number().min(0).max(1).optional(),
  /** Free-text explanation shown beside the row on the review screen. */
  detail: z.string().optional(),
  resolvedValue: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
