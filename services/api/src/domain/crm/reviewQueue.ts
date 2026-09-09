import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { CorruptRecordError, conflict, corruptRecord, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { REVIEW_ITEM_SORT_KEY, reviewItemPartitionKey, reviewQueueGsi1Pk } from "./keys";

/**
 * The migration review queue: the rows the importer could not apply
 * deterministically, parked for a human. Spec §9.
 *
 * Storage shape mirrors partners.ts — one item per review item, the record
 * itself under the shared meta sort key, and a GSI1 partition per review
 * status so the screen is one query rather than a scan.
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
}

export async function recordReviewItem(
  context: AppContext,
  tenantId: string,
  input: RecordReviewItemInput,
): Promise<crm.ReviewItem> {
  const createdAt = context.now().toISOString();
  const reviewItem = crm.ReviewItemSchema.parse({
    tenantId,
    reviewItemId: newId("rev", context.now().getTime()),
    reason: input.reason,
    reviewStatus: "OPEN",
    sourceSheet: input.sourceSheet,
    sourceRow: input.sourceRow,
    caseRef: input.caseRef,
    fieldName: input.fieldName,
    rawValue: input.rawValue,
    // Spread conditionally rather than assigning undefined: DynamoDB rejects an
    // undefined attribute value, and a key that merely exists renders as an
    // empty suggestion on the review screen.
    ...(input.proposedValue !== undefined ? { proposedValue: input.proposedValue } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt,
  });

  await writeReviewItem(context, reviewItem);
  return reviewItem;
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
  const storedItems = await context.table.queryGsi(
    "GSI1",
    reviewQueueGsi1Pk(tenantId, reviewStatus),
    { limit, scanForward: true },
  );
  const loadedReviewItems: crm.ReviewItem[] = [];
  const unreadableReviewItemIds: string[] = [];
  for (const storedItem of storedItems) {
    try {
      loadedReviewItems.push(parseStoredReviewItem(storedItem));
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      unreadableReviewItemIds.push(error.recordId);
      console.warn(
        `Skipped unreadable CRM review item ${error.recordId} in tenant ${tenantId}: ${error.reason}`,
      );
    }
  }
  return { reviewItems: loadedReviewItems, unreadableReviewItemIds };
}

export async function getReviewItemOrThrow(
  context: AppContext,
  tenantId: string,
  reviewItemId: string,
): Promise<crm.ReviewItem> {
  const storedItem = await context.table.get(
    reviewItemPartitionKey(tenantId, reviewItemId),
    REVIEW_ITEM_SORT_KEY,
  );
  if (!storedItem) throw notFound("Review item");
  return parseStoredReviewItem(storedItem);
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

  const resolvedItem = crm.ReviewItemSchema.parse({
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
 * The single place a review item reaches storage.
 *
 * GSI1PK is derived from the item's own status on every write, so a resolved
 * item leaves the OPEN partition. Writing it once at creation and not again
 * leaves resolved items in the OPEN partition forever, and the review screen
 * never empties.
 */
async function writeReviewItem(context: AppContext, reviewItem: crm.ReviewItem): Promise<void> {
  await context.table.put({
    PK: reviewItemPartitionKey(reviewItem.tenantId, reviewItem.reviewItemId),
    SK: REVIEW_ITEM_SORT_KEY,
    GSI1PK: reviewQueueGsi1Pk(reviewItem.tenantId, reviewItem.reviewStatus),
    // createdAt, not resolvedAt: the queue is read oldest-first and a resolved
    // item keeps the position it was imported at.
    GSI1SK: reviewItem.createdAt,
    ...reviewItem,
  });
}

/**
 * The single place a stored item becomes a domain ReviewItem.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so a review row that no longer satisfies ReviewItemSchema would
 * answer 500 from every read. Typed as CorruptRecordError it answers 409,
 * exactly as partners.ts does, and listReviewItems can then catch precisely
 * this and let everything else propagate.
 */
function parseStoredReviewItem(storedItem: TableItem): crm.ReviewItem {
  try {
    return crm.ReviewItemSchema.parse(stripStorageKeys(storedItem));
  } catch (error) {
    if (error instanceof ZodError) {
      throw corruptRecord(
        "Review item",
        reviewItemIdOfStoredItem(storedItem),
        describeFirstIssue(error),
      );
    }
    throw error;
  }
}

/**
 * The id that names a stored review row. The body carries it, but a row that
 * lost it is exactly the kind of row this path exists for, and
 * String(undefined) would report the literal id "undefined" — which finds
 * nothing. The storage key always names the row, so it is the fallback.
 */
function reviewItemIdOfStoredItem(storedItem: TableItem): string {
  const storedReviewItemId = storedItem["reviewItemId"];
  if (typeof storedReviewItemId === "string" && storedReviewItemId.length > 0) {
    return storedReviewItemId;
  }
  return storedItem.PK;
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
}

/** Storage attributes are not domain fields — drop them before parsing. */
function stripStorageKeys(storedItem: Record<string, unknown>): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1Pk,
    GSI1SK: _gsi1Sk,
    ...domainFields
  } = storedItem;
  return domainFields;
}
