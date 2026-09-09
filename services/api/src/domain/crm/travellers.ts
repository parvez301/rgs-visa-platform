import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { passportGsi3Pk, travellerNameGsi2Pk, travellerPartitionKey } from "./keys";

export interface UpsertTravellerInput {
  fullName: string;
  passportNumber?: string;
  dateOfBirth?: string;
  phone?: string;
}

/** Uppercase, trimmed, single-spaced, apostrophes folded — the fuzzy fallback key from spec §5. */
export function normalizeTravellerName(fullName: string): string {
  return crm.buildLookupKey(fullName);
}

/**
 * Returns the existing traveller when the passport is already on file for this
 * tenant. Recognising a repeat traveller is the thing the spreadsheet cannot do.
 */
export async function upsertTraveller(
  context: AppContext,
  tenantId: string,
  input: UpsertTravellerInput,
): Promise<crm.CrmTraveller> {
  if (input.passportNumber !== undefined) {
    const existing = await findTravellerByPassport(context, tenantId, input.passportNumber);
    if (existing) return existing;
  }

  const traveller = crm.CrmTravellerSchema.parse({
    tenantId,
    travellerId: newId("trv", context.now().getTime()),
    fullName: input.fullName,
    normalizedName: normalizeTravellerName(input.fullName),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.passportNumber !== undefined ? { passportNumber: input.passportNumber } : {}),
    createdAt: context.now().toISOString(),
  });

  await context.table.put({
    PK: travellerPartitionKey(tenantId, traveller.travellerId),
    SK: "META",
    GSI2PK: travellerNameGsi2Pk(tenantId, traveller.normalizedName),
    GSI2SK: traveller.travellerId,
    ...(traveller.passportNumber !== undefined
      ? {
          GSI3PK: passportGsi3Pk(tenantId, traveller.passportNumber),
          GSI3SK: traveller.travellerId,
        }
      : {}),
    ...traveller,
  });
  return traveller;
}

export async function findTravellerByPassport(
  context: AppContext,
  tenantId: string,
  passportNumber: string,
): Promise<crm.CrmTraveller | undefined> {
  const matches = await context.table.queryGsi(
    "GSI3",
    passportGsi3Pk(tenantId, passportNumber),
    { limit: 1 },
  );
  const firstMatch = matches[0];
  return firstMatch ? crm.CrmTravellerSchema.parse(stripKeys(firstMatch)) : undefined;
}

export async function getTravellerOrThrow(
  context: AppContext,
  tenantId: string,
  travellerId: string,
): Promise<crm.CrmTraveller> {
  const travellerItem = await context.table.get(
    travellerPartitionKey(tenantId, travellerId),
    "META",
  );
  if (!travellerItem) throw notFound("Traveller");
  return crm.CrmTravellerSchema.parse(stripKeys(travellerItem));
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI2PK: _gsi2Pk,
    GSI2SK: _gsi2Sk,
    GSI3PK: _gsi3Pk,
    GSI3SK: _gsi3Sk,
    ...domainFields
  } = item;
  return domainFields;
}
