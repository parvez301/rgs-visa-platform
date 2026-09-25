import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, travellerPartitionKey } from "./keys";

/**
 * The names behind a case's applicants, keyed by `travellerId` (spec
 * 2026-09-25 D7). Best-effort on purpose, the same discipline as
 * `resolveLedgerSearchText`: a traveller that is missing or will not parse is
 * simply absent from the map, and the reader falls back to
 * `crm.displayApplicantName`'s "Unnamed applicant". One `get` per distinct
 * traveller; a family of four costs four reads.
 */
export async function resolveCaseTravellers(
  context: AppContext,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
): Promise<crm.CaseTravellerMap> {
  const travellers: crm.CaseTravellerMap = {};
  const distinctTravellerIds = [...new Set(applicants.map((applicant) => applicant.travellerId))];
  for (const travellerId of distinctTravellerIds) {
    const travellerItem = await context.table.get(travellerPartitionKey(tenantId, travellerId), META_SORT_KEY);
    if (travellerItem === undefined) continue;
    const parsedTraveller = crm.CrmTravellerSchema.safeParse(stripStorageKeys(travellerItem));
    if (!parsedTraveller.success) continue;
    travellers[travellerId] = {
      fullName: parsedTraveller.data.fullName,
      ...(parsedTraveller.data.passportNumber !== undefined
        ? { passportNumber: parsedTraveller.data.passportNumber }
        : {}),
    };
  }
  return travellers;
}
