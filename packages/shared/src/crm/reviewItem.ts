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
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

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
