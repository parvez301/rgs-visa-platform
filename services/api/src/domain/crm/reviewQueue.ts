import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { describeFirstZodIssue } from "../../lib/storedRecords";
import { requireSql } from "./postgresClient";
import {
  getReviewItemPostgres,
  insertReviewItemPostgres,
  listOpenReviewSummaryRowsPostgres,
  listReviewItemsPostgres,
} from "./reviewQueuePostgres";

/**
 * The migration review queue: the rows the importer could not apply
 * deterministically, parked for a human. Spec §9.
 *
 * One row per review item in `crm_review_items` (reviewQueuePostgres.ts),
 * indexed on (tenant_id, review_status). The review-group sweep
 * (reviewGroups.ts) reads the same table.
 */
export interface RecordReviewItemInput {
  reason: crm.ReviewReason;
  sourceSheet: string;
  sourceRow: number;
  caseRef: string;
  fieldName: string;
  rawValue: string;
  proposedValue?: string;
  confidence?: number;
  detail?: string;
}

export interface ReviewItemListing {
  reviewItems: crm.ReviewItem[];
  /**
   * Rows the tenant has that could not be turned back into a ReviewItem. Named
   * rather than merely absent, so an item vanishing from the queue does not
   * look like an item that was never imported.
   */
  unreadableReviewItemIds: string[];
  /**
   * True when the queue holds more items than this page returned.
   *
   * A real import puts 3,932 OPEN items into the queue, of which
   * this returns 200 — so 5.1% of the queue was reachable and nothing in the
   * response said so. An operator works the 200 they can see, refreshes,
   * sees another 200, and at some point concludes the migration is clean
   * while 3,732 items (including every fabricated country and placeholder
   * date) sit behind the cap. Truncation a caller cannot detect is worse
   * than a smaller page.
   */
  hasMore: boolean;
}

export async function recordReviewItem(
  context: AppContext,
  tenantId: string,
  input: RecordReviewItemInput,
): Promise<crm.ReviewItem> {
  const createdAt = context.now().toISOString();
  const reviewItem = parseNewReviewItem({
    tenantId,
    reviewItemId: newId("rev", context.now().getTime()),
    reason: input.reason,
    reviewStatus: "OPEN",
    sourceSheet: input.sourceSheet,
    sourceRow: input.sourceRow,
    caseRef: input.caseRef,
    fieldName: input.fieldName,
    rawValue: input.rawValue,
    // Spread conditionally rather than assigning undefined: a key that merely
    // exists renders as an empty suggestion on the review screen.
    ...(input.proposedValue !== undefined ? { proposedValue: input.proposedValue } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt,
  });

  await writeReviewItem(context, reviewItem);
  return reviewItem;
}

/**
 * The write-path parse, and the only place a caller's input becomes a
 * ReviewItem.
 *
 * Raw, this was `crm.ReviewItemSchema.parse(...)`, so a value the schema
 * refuses — `confidence: -0.2` from a pass-2 resolver is the live example,
 * since nothing validates what a resolver returns — threw an untyped ZodError
 * out of the middle of an import that had already written N cases. router.ts
 * maps only ApiError, and the project constraint is that every rejected
 * operation throws a typed error from lib/errors. A caller sending a value
 * the schema refuses is a 400, and it now says which field.
 */
function parseNewReviewItem(candidateReviewItem: Record<string, unknown>): crm.ReviewItem {
  try {
    return crm.ReviewItemSchema.parse(candidateReviewItem);
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(`Review item ${describeFirstZodIssue(error)}`);
    }
    throw error;
  }
}

/**
 * One corrupt review row must not take the whole queue down with it — the same
 * blast radius already fixed for the case queue and the partner list, where a
 * single half-written row 500'd the screen for every operator in the tenant.
 * The bad row is skipped, warned about with the id that finds it, and named in
 * `unreadableReviewItemIds`. Only CorruptRecordError is swallowed; every other
 * failure still propagates.
 *
 * This is not hypothetical here: the queue is filled by an importer walking
 * thousands of free-text spreadsheet rows, so it is the most likely place in
 * the CRM to hold a row that will not parse.
 */
export async function listReviewItems(
  context: AppContext,
  tenantId: string,
  reviewStatus: crm.ReviewStatus,
  limit = 200,
): Promise<ReviewItemListing> {
  return listReviewItemsPostgres(requireSql(context), tenantId, reviewStatus, limit);
}

export async function getReviewItemOrThrow(
  context: AppContext,
  tenantId: string,
  reviewItemId: string,
): Promise<crm.ReviewItem> {
  const postgresItem = await getReviewItemPostgres(requireSql(context), tenantId, reviewItemId);
  if (!postgresItem) throw notFound("Review item");
  return postgresItem;
}

export interface ReviewItemResolution {
  reviewStatus: "APPLIED" | "DISMISSED";
  resolvedValue?: string;
}

/**
 * Closes an open review item. Two reviewers working the queue at once is the
 * expected case, so a second resolution of the same item is a 409 rather than
 * a silent overwrite of the first reviewer's decision.
 */
export async function resolveReviewItem(
  context: AppContext,
  tenantId: string,
  reviewItemId: string,
  resolution: ReviewItemResolution,
  actorEmail: string,
): Promise<crm.ReviewItem> {
  const existingItem = await getReviewItemOrThrow(context, tenantId, reviewItemId);
  if (existingItem.reviewStatus !== "OPEN") {
    throw conflict(
      `Review item ${reviewItemId} is already ${existingItem.reviewStatus} and cannot be resolved again`,
    );
  }

  const resolvedItem = parseNewReviewItem({
    ...existingItem,
    reviewStatus: resolution.reviewStatus,
    ...(resolution.resolvedValue !== undefined ? { resolvedValue: resolution.resolvedValue } : {}),
    resolvedBy: actorEmail,
    resolvedAt: context.now().toISOString(),
  });

  await writeReviewItem(context, resolvedItem);
  return resolvedItem;
}

/**
 * The single place a review item reaches storage. The status column is
 * written with every item, so a resolved item leaves the OPEN queue.
 */
async function writeReviewItem(context: AppContext, reviewItem: crm.ReviewItem): Promise<void> {
  await insertReviewItemPostgres(requireSql(context), reviewItem);
}

/**
 * Which cases have unresolved import problems, cheaply enough to draw on every
 * Ledger load.
 *
 * `listReviewItems` cannot answer this: it caps at 200 of 3,958 OPEN items and
 * has no cursor, so a marker built on it would appear on 5% of the dirty rows
 * and nowhere else -- which reads as "the rest are clean". This reads the whole
 * OPEN queue instead, and carries the item ids so opening a marker is a single
 * lookup per item actually opened rather than a second sweep.
 */
export interface OpenReviewSummaryEntry {
  caseRef: string;
  /**
   * Every reason with an open item on this case, guesses included, so the
   * Ledger can FILTER by any of them. The two id lists below carry only the
   * reasons the Ledger BADGES (LEDGER_MARKER_REASONS); a case whose only open
   * items are guesses has an entry here with both lists empty.
   */
  openReasons: crm.ReviewReason[];
  /** Items about one cell: a value that could not be read or mapped. */
  fieldItemIds: string[];
  /** Items about two rows: DUPLICATE_REF. */
  mergeItemIds: string[];
}

export interface OpenReviewSummary {
  entries: OpenReviewSummaryEntry[];
  unreadableReviewItemIds: string[];
}

/**
 * Derived from `ReviewItemSchema`, not hand-rolled beside it. The projection
 * deliberately omits fields that schema requires, so the whole schema cannot be
 * used here -- but `.pick()` takes exactly the three the projection carries, which
 * means a new `REVIEW_REASONS` member or a tightened `caseRef` reaches this sweep
 * with no edit here at all. Two hand-kept notions of "a usable row" in one file is
 * how the second one goes stale.
 */
const OpenReviewSummaryRowSchema = crm.ReviewItemSchema.pick({
  reviewItemId: true,
  caseRef: true,
  reason: true,
});

export async function summariseOpenReviewItems(
  context: AppContext,
  tenantId: string,
): Promise<OpenReviewSummary> {
  // The candidate the schema checks, the id to name the row by when it fails,
  // and the label the warning points at.
  const summaryRows = (await listOpenReviewSummaryRowsPostgres(requireSql(context), tenantId)).map(
    (postgresRow) => ({
      candidate: postgresRow.candidate,
      fallbackId: postgresRow.reviewItemId,
      rowLabel: postgresRow.reviewItemId,
    }),
  );

  const entriesByCaseRef = new Map<string, OpenReviewSummaryEntry>();
  const unreadableReviewItemIds: string[] = [];

  for (const { candidate, fallbackId, rowLabel } of summaryRows) {
    const parsedRow = OpenReviewSummaryRowSchema.safeParse(candidate);
    if (!parsedRow.success) {
      // Named, not dropped: an item missing from this summary is a dirty row
      // that renders as clean, which is the one thing the marker exists to
      // prevent. The storage key is the fallback id because it is all an
      // operator has to find the row with. This reads the raw item, not the
      // parse result -- the parse just failed, so it has nothing to offer.
      const rawReviewItemId = candidate["reviewItemId"];
      unreadableReviewItemIds.push(
        typeof rawReviewItemId === "string" && rawReviewItemId.length > 0
          ? rawReviewItemId
          : fallbackId,
      );
      console.warn(`CRM review item in tenant ${tenantId} could not be summarised: ${rowLabel}`);
      continue;
    }

    const { reviewItemId, caseRef, reason } = parsedRow.data;
    const entry = entriesByCaseRef.get(caseRef) ?? {
      caseRef,
      openReasons: [],
      fieldItemIds: [],
      mergeItemIds: [],
    };
    if (!entry.openReasons.includes(reason)) entry.openReasons.push(reason);
    entriesByCaseRef.set(caseRef, entry);
    // Still OPEN, still filterable, still on the review screen -- just not
    // drawn on the grid. See LEDGER_MARKER_REASONS for the measured reason.
    if (!crm.isLedgerMarkerReason(reason)) continue;
    if (crm.isMergeReviewReason(reason)) {
      entry.mergeItemIds.push(reviewItemId);
    } else {
      entry.fieldItemIds.push(reviewItemId);
    }
    entriesByCaseRef.set(caseRef, entry);
  }

  return { entries: [...entriesByCaseRef.values()], unreadableReviewItemIds };
}
