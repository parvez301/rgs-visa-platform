import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, travellerPartitionKey } from "./keys";

/**
 * Resolves each applicant's traveller (best-effort) and builds the Ledger
 * `searchText` haystack. A missing or unreadable traveller is skipped rather
 * than failing the write: `writeCase` must still persist the case, and an
 * applicant `passportNumber` alone is still searchable.
 *
 * Shared with the searchText backfill so "what would writeCase stamp" has
 * exactly one answer.
 */
export async function resolveLedgerSearchText(
  context: AppContext,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
): Promise<string | undefined> {
  const searchParts: { fullName?: string; passportNumber?: string }[] = [];
  for (const applicant of applicants) {
    const travellerItem = await context.table.get(
      travellerPartitionKey(tenantId, applicant.travellerId),
      META_SORT_KEY,
    );
    if (travellerItem === undefined) {
      searchParts.push({ passportNumber: applicant.passportNumber });
      continue;
    }
    const parsedTraveller = crm.CrmTravellerSchema.safeParse(stripStorageKeys(travellerItem));
    if (!parsedTraveller.success) {
      searchParts.push({ passportNumber: applicant.passportNumber });
      continue;
    }
    searchParts.push({
      fullName: parsedTraveller.data.fullName,
      passportNumber: parsedTraveller.data.passportNumber ?? applicant.passportNumber,
    });
  }
  return crm.buildLedgerSearchText(searchParts);
}
