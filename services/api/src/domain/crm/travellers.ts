import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { badRequest, corruptRecord, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import {
  META_SORT_KEY,
  passportGsi3Pk,
  travellerNameGsi2Pk,
  travellerPartitionKey,
} from "./keys";

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

  // Unwrapped, a ZodError here is not an ApiError, and router.ts maps only
  // ApiError subclasses — so "   " as a full name (which buildLookupKey trims
  // to "") came back as a 500. Every case creation goes through this call, so
  // it must fail the way the rest of the API fails: a typed 400.
  let traveller: crm.CrmTraveller;
  try {
    traveller = crm.CrmTravellerSchema.parse({
      tenantId,
      travellerId: newId("trv", context.now().getTime()),
      fullName: input.fullName,
      normalizedName: normalizeTravellerName(input.fullName),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.passportNumber !== undefined ? { passportNumber: input.passportNumber } : {}),
      createdAt: context.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid traveller",
      );
    }
    throw error;
  }

  await context.table.put({
    PK: travellerPartitionKey(tenantId, traveller.travellerId),
    SK: META_SORT_KEY,
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
  return firstMatch ? parseStoredTraveller(firstMatch) : undefined;
}

/**
 * Fuzzy fallback for the 74% of rows that carry no passport number (spec §5):
 * matches on the normalized full name via GSI2, mirroring how
 * findTravellerByPassport matches on GSI3. Not unique — two different people
 * can share a normalized name — so this returns the earliest match, same as
 * the passport lookup.
 */
export async function findTravellerByName(
  context: AppContext,
  tenantId: string,
  fullName: string,
): Promise<crm.CrmTraveller | undefined> {
  const matches = await context.table.queryGsi(
    "GSI2",
    travellerNameGsi2Pk(tenantId, normalizeTravellerName(fullName)),
    { limit: 1 },
  );
  const firstMatch = matches[0];
  return firstMatch ? parseStoredTraveller(firstMatch) : undefined;
}

export async function getTravellerOrThrow(
  context: AppContext,
  tenantId: string,
  travellerId: string,
): Promise<crm.CrmTraveller> {
  const travellerItem = await context.table.get(
    travellerPartitionKey(tenantId, travellerId),
    META_SORT_KEY,
  );
  if (!travellerItem) throw notFound("Traveller");
  return parseStoredTraveller(travellerItem);
}

/**
 * The single place a stored traveller item becomes a domain CrmTraveller.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so a half-written traveller row escaped every read here as a
 * 500. Typed as CorruptRecordError it answers 409, exactly as readCase already
 * does for a case partition that will not reassemble.
 */
function parseStoredTraveller(travellerItem: TableItem): crm.CrmTraveller {
  try {
    return crm.CrmTravellerSchema.parse(stripKeys(travellerItem));
  } catch (error) {
    if (error instanceof ZodError) {
      throw corruptRecord(
        "Traveller",
        travellerIdOfStoredItem(travellerItem),
        describeFirstIssue(error),
      );
    }
    throw error;
  }
}

/**
 * The id that names a stored traveller row. The body carries it, but a row that
 * lost it is exactly the kind of row this path exists for, and
 * String(undefined) would report the literal id "undefined" — which finds
 * nothing. The storage key always names the row, so it is the fallback.
 */
function travellerIdOfStoredItem(travellerItem: TableItem): string {
  const storedTravellerId = travellerItem["travellerId"];
  if (typeof storedTravellerId === "string" && storedTravellerId.length > 0) {
    return storedTravellerId;
  }
  return travellerItem.PK;
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
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
