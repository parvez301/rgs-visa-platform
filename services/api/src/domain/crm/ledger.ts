import { crm } from "@rgs/shared";
import type { TableItem } from "../../lib/db";
import { corruptRecord } from "../../lib/errors";
import { parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import { caseIdFromPartitionKey } from "./keys";

/**
 * The Ledger read model (spec §2.1): page size limits and the row type. The
 * live query is `listLedgerRowsFromPostgres` in `ledgerPostgres.ts`; the
 * projection list and `parseLedgerRow` stay only for the legacy Dynamo
 * backfill in `services/migration`.
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
  "groupName",
  "partnerId",
  "destinationCountry",
  "caseType",
  "visaType",
  "caseStatus",
  "billingStatus",
  "receivedDate",
  "appointmentDate",
  "expectedCollectionDate",
  "totalInr",
  "updatedAt",
  "applicantSummary",
  "searchText",
];


export const DEFAULT_LEDGER_PAGE_LIMIT = 500;
export const MAX_LEDGER_PAGE_LIMIT = 1000;

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
 * A projected META item becomes one Ledger row, or names itself as unreadable.
 *
 * The caseId comes from the body when it is there and from the partition key
 * when it is not, exactly as `cases.ts` does -- a half-written or hand-repaired
 * item is the case that most needs to be findable.
 */
export function parseLedgerRow(metaItem: TableItem): crm.LedgerRow {
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
