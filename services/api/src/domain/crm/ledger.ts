import { crm } from "@rgs/shared";

/**
 * The Ledger read model (spec §2.1): page size limits and the row type. The
 * live query is `listLedgerRowsFromPostgres` in `ledgerPostgres.ts`.
 */

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
