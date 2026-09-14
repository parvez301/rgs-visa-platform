import { crm } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem, TableItemKey } from "../../lib/db";
import { badRequest, corruptRecord } from "../../lib/errors";
import { collectReadableRecords, parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import {
  META_SORT_KEY,
  caseIdFromPartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";

/**
 * The Ledger read model (spec §2.1).
 *
 * `listCasesByStatus` cannot serve this screen: it defaults to 50 rows of one
 * status and calls `readCase` per case -- a strongly-consistent GetItem plus a
 * strongly-consistent Query each, 14,312 sequential round-trips for the real
 * 7,156-case ledger, to rebuild applicant arrays no column displays. Every
 * case-level column the Ledger shows is already on the META item that the GSI
 * query returns (`caseStore.writeCase` spreads `...caseBody` onto it), so this
 * module reads those items, projects the Ledger's columns off them, and
 * reassembles nothing.
 */

/**
 * Exactly the columns spec §4 lists, plus the two storage keys every reader
 * here needs: `SK` to tell a META item from an applicant item, `PK` to recover
 * a caseId from a row whose body has lost one.
 *
 * `legacyRaw` and `lineItems` are deliberately absent, and a test asserts it:
 * they are the difference between a 1.4 MB page and a 7-21 MB one.
 */
export const LEDGER_PROJECTED_ATTRIBUTES: readonly string[] = [
  "PK",
  "SK",
  "caseId",
  "caseRef",
  "partnerId",
  "destinationCountry",
  "caseType",
  "visaType",
  "caseStatus",
  "billingStatus",
  "receivedDate",
  "appointmentDate",
  "totalInr",
  "updatedAt",
  "applicantSummary",
];

export const DEFAULT_LEDGER_PAGE_LIMIT = 500;
export const MAX_LEDGER_PAGE_LIMIT = 1000;

/**
 * A hard stop on the page-filling loop. A partition that keeps answering with
 * a cursor and no rows would otherwise spin forever inside one HTTP request;
 * bounded, the caller gets a short page and a cursor, which is a state the
 * client already handles.
 */
const MAX_PARTITION_QUERIES_PER_PAGE = 64;

export interface LedgerQuery {
  /**
   * Canonicalized on entry to `listLedgerRows` -- deduped and sorted -- so a
   * repeated status cannot read the same partition twice and the same set in
   * a different caller order cannot collide with a cursor's `partitionIndex`
   * (fix round 1, F1/F2). Callers need not dedupe or order this themselves.
   * Ignored entirely when `partnerId` is set.
   */
  statuses: crm.CaseStatus[];
  partnerId?: string;
  limit: number;
  cursor?: string;
}

export interface LedgerPage {
  rows: crm.LedgerRow[];
  /**
   * META items the projection could not parse. Named rather than dropped, for
   * the reason every listing in this codebase names them: a case missing from
   * the Ledger is indistinguishable from a case that was never imported.
   */
  unreadableCaseIds: string[];
  nextCursor?: string;
}

/**
 * Where a page stopped. `scopeKey` pins the filter the cursor was issued for:
 * a client that changes its status filter mid-scroll and sends the old cursor
 * would otherwise resume at partition 3 of a different list of partitions and
 * quietly skip two statuses. Refused instead.
 */
const LedgerCursorSchema = z.object({
  v: z.literal(1),
  scopeKey: z.string().min(1),
  partitionIndex: z.number().int().nonnegative(),
  startKey: z.record(z.unknown()).optional(),
});
type LedgerCursor = z.infer<typeof LedgerCursorSchema>;

/**
 * Takes the already-canonicalized status list, never `query.statuses` raw
 * (fix round 1, F1/F2) -- a caller must not be able to reach this with an
 * unsorted or duplicated array, because `partitionIndex` in the cursor is an
 * index into a `partitionKeys` array built from exactly this same order.
 */
function scopeKeyFor(partnerId: string | undefined, canonicalStatuses: readonly crm.CaseStatus[]): string {
  return partnerId !== undefined
    ? `partner:${partnerId}`
    : `status:${canonicalStatuses.join(",")}`;
}

function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A cursor that will not decode is a 400, never a silent restart from row one:
 * an infinite-scroll client handed "start again" instead of an error appends
 * the first page forever.
 */
function decodeLedgerCursor(rawCursor: string, expectedScopeKey: string): LedgerCursor {
  let parsedCursor: LedgerCursor;
  try {
    parsedCursor = LedgerCursorSchema.parse(
      JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")),
    );
  } catch {
    throw badRequest("This ledger cursor could not be read");
  }
  if (parsedCursor.scopeKey !== expectedScopeKey) {
    throw badRequest(
      "This ledger cursor was issued for a different filter; start again from the first page",
    );
  }
  return parsedCursor;
}

export async function listLedgerRows(
  context: AppContext,
  tenantId: string,
  query: LedgerQuery,
): Promise<LedgerPage> {
  // Canonicalized ONCE, here, and nothing downstream reads `query.statuses`
  // again (fix round 1, F1/F2). Deduping means a repeated status cannot read
  // its partition twice -- the reviewer's direct repro. Sorting means the same
  // set of statuses, sent in any caller order, canonicalizes identically, so
  // `partitionKeys` below is always built in the same order for the same set
  // and a cursor's `partitionIndex` -- an index INTO that array -- stays valid
  // no matter what order the caller asked in. The alternative (canonicalize
  // only the scopeKey) was considered and rejected: it would make the
  // different-order 400 disappear while `partitionIndex` still pointed at the
  // wrong partition of the wrong list, silently skipping a whole status
  // instead of refusing the cursor.
  const canonicalStatuses = [...new Set(query.statuses)].sort();

  const scopeKey = scopeKeyFor(query.partnerId, canonicalStatuses);
  const resumeFrom =
    query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor, scopeKey);

  // Partner mode is one GSI2 partition ordered by receivedDate; status mode is
  // one GSI1 partition per canonical (deduped, sorted) status, each ordered by
  // updatedAt. The rest of this function does not care which it got.
  const indexName = query.partnerId !== undefined ? "GSI2" : "GSI1";
  const partitionKeys =
    query.partnerId !== undefined
      ? [partnerCasesGsi2Pk(tenantId, query.partnerId)]
      : canonicalStatuses.map((caseStatus) => caseStatusGsi1Pk(tenantId, caseStatus));

  const collectedItems: TableItem[] = [];
  let partitionIndex = resumeFrom?.partitionIndex ?? 0;
  let startKey: TableItemKey | undefined = resumeFrom?.startKey;
  let nextCursor: string | undefined;
  let queryCount = 0;

  while (partitionIndex < partitionKeys.length) {
    const remainingRowCount = query.limit - collectedItems.length;
    if (remainingRowCount <= 0 || queryCount >= MAX_PARTITION_QUERIES_PER_PAGE) {
      nextCursor = encodeLedgerCursor({
        v: 1,
        scopeKey,
        partitionIndex,
        ...(startKey !== undefined ? { startKey } : {}),
      });
      break;
    }

    const page = await context.table.queryGsiPage(indexName, partitionKeys[partitionIndex]!, {
      limit: remainingRowCount,
      scanForward: false,
      projection: LEDGER_PROJECTED_ATTRIBUTES,
      ...(startKey !== undefined ? { startKey } : {}),
    });
    queryCount += 1;
    collectedItems.push(...page.items.filter((item) => item["SK"] === META_SORT_KEY));

    if (page.nextStartKey !== undefined) {
      startKey = page.nextStartKey;
    } else {
      partitionIndex += 1;
      startKey = undefined;
    }
  }

  const { records, unreadableRecordIds } = await collectReadableRecords(
    collectedItems,
    parseLedgerRow,
    { entityDescription: "CRM ledger row", scopeDescription: `tenant ${tenantId}` },
  );

  return {
    rows: records,
    unreadableCaseIds: unreadableRecordIds,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/**
 * A projected META item becomes one Ledger row, or names itself as unreadable.
 *
 * The caseId comes from the body when it is there and from the partition key
 * when it is not, exactly as `cases.ts` does -- a half-written or hand-repaired
 * item is the case that most needs to be findable.
 */
function parseLedgerRow(metaItem: TableItem): crm.LedgerRow {
  const caseIdFromBody = metaItem["caseId"];
  const caseId =
    typeof caseIdFromBody === "string" && caseIdFromBody.length > 0
      ? caseIdFromBody
      : caseIdFromPartitionKey(metaItem.PK);
  if (caseId === undefined) {
    throw corruptRecord("Ledger row", metaItem.PK, "the row names no caseId at all");
  }
  return parseStoredRecord(crm.LedgerRowSchema, "Ledger row", caseId, {
    ...stripStorageKeys(metaItem),
    caseId,
  });
}
