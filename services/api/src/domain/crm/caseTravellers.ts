import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { requireSql } from "./postgresClient";
import { getTravellersByIdPostgres } from "./travellersPostgres";

/**
 * The names behind a case's applicants, keyed by `travellerId` (spec
 * 2026-09-25 D7). Best-effort on purpose, the same discipline as
 * ledger search text: a traveller that is missing or will not parse is
 * simply absent from the map, and the reader falls back to
 * `crm.displayApplicantName`'s "Unnamed applicant". One batched query, since
 * every round-trip queues on a single pooled connection.
 */
export async function resolveCaseTravellers(
  context: AppContext,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
): Promise<crm.CaseTravellerMap> {
  const travellers: crm.CaseTravellerMap = {};
  const distinctTravellerIds = [...new Set(applicants.map((applicant) => applicant.travellerId))];
  const postgresTravellers = await getTravellersByIdPostgres(
    requireSql(context),
    tenantId,
    distinctTravellerIds,
  );
  for (const travellerId of distinctTravellerIds) {
    const storedTraveller = postgresTravellers.get(travellerId);
    if (storedTraveller === undefined) continue;
    const parsedTraveller = crm.CrmTravellerSchema.safeParse(storedTraveller);
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
