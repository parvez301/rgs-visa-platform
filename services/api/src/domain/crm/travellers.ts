import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import {
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../../lib/storedRecords";
import {
  META_SORT_KEY,
  passportGsi3Pk,
  travellerNameGsi2Pk,
  travellerPartitionKey,
} from "./keys";
import { crmPostgresOf } from "./postgresClient";
import {
  findTravellerByNamePostgres,
  findTravellerByPassportPostgres,
  getTravellerPostgres,
  insertTravellerPostgres,
  updateTravellerDetailsPostgres,
} from "./travellersPostgres";
import { isUniqueViolation } from "../../lib/sqlColumns";

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

  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    const wasInserted = await insertTravellerPostgres(sql, traveller);
    if (wasInserted) return traveller;
    // The passport unique index refused us: another request registered the
    // same passport between our lookup and our insert. Return its traveller --
    // recognising a repeat traveller is the whole point of the upsert.
    const winner = traveller.passportNumber === undefined
      ? undefined
      : await findTravellerByPassport(context, tenantId, traveller.passportNumber);
    if (winner === undefined) throw conflict("Traveller could not be created; please retry.");
    return winner;
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
  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    const stored = await findTravellerByPassportPostgres(sql, tenantId, passportNumber);
    return stored ? parseStoredTraveller(stored) : undefined;
  }
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
  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    const stored = await findTravellerByNamePostgres(sql, tenantId, normalizeTravellerName(fullName));
    return stored ? parseStoredTraveller(stored) : undefined;
  }
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
  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    const stored = await getTravellerPostgres(sql, tenantId, travellerId);
    if (!stored) throw notFound("Traveller");
    return parseStoredTraveller(stored);
  }
  const travellerItem = await context.table.get(
    travellerPartitionKey(tenantId, travellerId),
    META_SORT_KEY,
  );
  if (!travellerItem) throw notFound("Traveller");
  return parseStoredTraveller(travellerItem);
}

export interface UpdateTravellerDetailsInput {
  fullName?: string;
  /** `null` clears the passport. */
  passportNumber?: string | null;
}

/**
 * Clash check without a write: a passport already on file for SOMEONE ELSE is
 * refused, because re-pointing it would merge two people. Callers that must
 * order other writes around the traveller write use this to fail early.
 */
export async function assertPassportFreeForTraveller(
  context: AppContext,
  tenantId: string,
  travellerId: string,
  passportNumber: string,
): Promise<void> {
  const passportHolder = await findTravellerByPassport(context, tenantId, passportNumber);
  if (passportHolder !== undefined && passportHolder.travellerId !== travellerId) {
    throw conflict(`Passport ${passportNumber} is already on file for ${passportHolder.fullName}.`);
  }
}

/**
 * A traveller is one person across every case, so a corrected name shows on
 * all of them -- the edit drawer says so. The name and passport indexes
 * (GSI2, GSI3) are rewritten with the item, and a passport already on file
 * for SOMEONE ELSE is refused: silently re-pointing it would merge two people.
 */
export async function updateTravellerDetails(
  context: AppContext,
  tenantId: string,
  travellerId: string,
  input: UpdateTravellerDetailsInput,
): Promise<crm.CrmTraveller> {
  const currentTraveller = await getTravellerOrThrow(context, tenantId, travellerId);
  const nextPassportNumber =
    input.passportNumber === undefined ? currentTraveller.passportNumber : (input.passportNumber ?? undefined);
  if (nextPassportNumber !== undefined && nextPassportNumber !== currentTraveller.passportNumber) {
    await assertPassportFreeForTraveller(context, tenantId, travellerId, nextPassportNumber);
  }
  const nextFullName = input.fullName ?? currentTraveller.fullName;
  const { passportNumber: _previousPassportNumber, ...travellerWithoutPassport } = currentTraveller;
  let updatedTraveller: crm.CrmTraveller;
  try {
    updatedTraveller = crm.CrmTravellerSchema.parse({
      ...travellerWithoutPassport,
      fullName: nextFullName,
      normalizedName: normalizeTravellerName(nextFullName),
      ...(nextPassportNumber !== undefined ? { passportNumber: nextPassportNumber } : {}),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid traveller");
    }
    throw error;
  }
  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    try {
      await updateTravellerDetailsPostgres(sql, updatedTraveller);
    } catch (error) {
      if (!isUniqueViolation(error) || updatedTraveller.passportNumber === undefined) throw error;
      // Lost a race with another writer of the same passport (the pre-check
      // above passed). Report it the way the pre-check would have.
      await assertPassportFreeForTraveller(context, tenantId, travellerId, updatedTraveller.passportNumber);
      throw conflict(`Passport ${updatedTraveller.passportNumber} is already on file for another traveller.`);
    }
    return updatedTraveller;
  }
  await context.table.put({
    PK: travellerPartitionKey(tenantId, travellerId),
    SK: META_SORT_KEY,
    GSI2PK: travellerNameGsi2Pk(tenantId, updatedTraveller.normalizedName),
    GSI2SK: travellerId,
    ...(updatedTraveller.passportNumber !== undefined
      ? { GSI3PK: passportGsi3Pk(tenantId, updatedTraveller.passportNumber), GSI3SK: travellerId }
      : {}),
    ...updatedTraveller,
  });
  return updatedTraveller;
}

/**
 * The single place a stored traveller item becomes a domain CrmTraveller.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so a half-written traveller row escaped every read here as a
 * 500. Typed as CorruptRecordError it answers 409, exactly as readCase already
 * does for a case partition that will not reassemble.
 */
function parseStoredTraveller(travellerItem: Record<string, unknown>): crm.CrmTraveller {
  return parseStoredRecord(
    crm.CrmTravellerSchema,
    "Traveller",
    storedRecordId(travellerItem, "travellerId"),
    stripStorageKeys(travellerItem),
  );
}
