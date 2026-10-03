import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import {
  collectReadableRecords,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../../lib/storedRecords";
import {
  getPartnerRowPostgres,
  insertPartnerPostgres,
  listPartnerRowsPostgres,
  updatePartnerContactPostgres,
} from "./partnersPostgres";
import { requireSql } from "./postgresClient";

export interface CreatePartnerInput {
  canonicalName: string;
  partnerType?: crm.PartnerType;
  aliases?: string[];
  notes?: string;
  contactPhone?: string;
  contactEmail?: string;
  contactWhatsapp?: string;
}

export async function createPartner(
  context: AppContext,
  tenantId: string,
  input: CreatePartnerInput,
  actorEmail: string,
): Promise<crm.Partner> {
  const normalized = crm.normalizePartnerName(input.canonicalName);
  if (normalized.canonicalKey === null) {
    throw badRequest("Partner name could not be normalized");
  }
  // Two partners on one canonical key is the exact failure normalizePartnerName
  // exists to prevent: the cases split across both, and so do that partner's
  // volume and revenue. 409 rather than returning the existing record, because
  // an operator typing a duplicate should be told; the bulk importer is
  // expected to call findPartnerByName first, by design.
  const existingPartner = await findPartnerByName(context, tenantId, input.canonicalName);
  if (existingPartner) {
    throw conflict(
      `Partner ${existingPartner.partnerId} (${existingPartner.canonicalName}) already uses the name ${input.canonicalName}`,
    );
  }

  const partner = crm.PartnerSchema.parse({
    tenantId,
    partnerId: newId("prt", context.now().getTime()),
    canonicalName: input.canonicalName,
    partnerType: input.partnerType ?? normalized.partnerType,
    aliases: input.aliases ?? [],
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
    ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
    ...(input.contactWhatsapp !== undefined ? { contactWhatsapp: input.contactWhatsapp } : {}),
    createdAt: context.now().toISOString(),
    // router.ts defaults a missing `email` claim to "", and an empty string is
    // not an author — omit the field rather than record a blank one, exactly as
    // createCase does. On PartnerSchema, so it can actually be read back.
    ...(actorEmail !== "" ? { createdByEmail: actorEmail } : {}),
  });

  await insertPartnerPostgres(requireSql(context), partner, normalized.canonicalKey);
  return partner;
}

export interface PartnerListing {
  partners: crm.Partner[];
  /**
   * Rows the tenant has that could not be turned back into a Partner. Named
   * rather than merely absent, so a partner vanishing from the list does not
   * look like a partner that was never there.
   */
  unreadablePartnerIds: string[];
}

/**
 * One corrupt partner row must not take the whole tenant's partner list down
 * with it — the identical blast radius already fixed for the case queue, where
 * one half-written partition 500'd the NEW queue for every operator. The bad
 * row is skipped, warned about with the id that finds it, and named in
 * `unreadablePartnerIds`. Only CorruptRecordError is swallowed; every other
 * failure still propagates.
 *
 * This stops being hypothetical the moment the migration importer creates
 * partners from 7,157 rows of free-text spreadsheet names.
 */
export async function listPartners(
  context: AppContext,
  tenantId: string,
): Promise<PartnerListing> {
  const partnerItems = (await listPartnerRowsPostgres(requireSql(context), tenantId)).map(
    (row) => row.candidate,
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    partnerItems,
    parseStoredPartner,
    { entityDescription: "CRM partner", scopeDescription: `tenant ${tenantId}` },
  );
  return { partners: records, unreadablePartnerIds: unreadableRecordIds };
}

export async function getPartnerOrThrow(
  context: AppContext,
  tenantId: string,
  partnerId: string,
): Promise<crm.Partner> {
  const partnerRow = await getPartnerRowPostgres(requireSql(context), tenantId, partnerId);
  if (!partnerRow) throw notFound("Partner");
  return parseStoredPartner(partnerRow.candidate);
}

/**
 * Folds the raw name through the shared normalizer, so "VWI Mumbai" and
 * "VWI BOM" resolve to the same partner rather than creating a duplicate.
 *
 * The partner's recorded aliases are consulted too, folded through the same
 * normalizer as the canonical name. Storing an alias and never reading it made
 * "Ozzy" a second partner beside "Ozzy Travels"; the migration importer
 * resolves partner names across every sheet row, so collapsing them here is the
 * whole point of recording them.
 *
 * Precedence is explicit and does not depend on the order the index returns
 * rows in: a partner whose own canonical name matches always wins, and an alias
 * is consulted only when no partner is actually called that. Folding both into
 * one `.find` let "Aaa Travel", merely because it listed "Ozzy Travels" as an
 * alias and sorts earlier, answer every lookup for the real Ozzy Travels — and
 * squat any partner's name across all 7,157 importer lookups.
 */
export async function findPartnerByName(
  context: AppContext,
  tenantId: string,
  rawName: string,
): Promise<crm.Partner | undefined> {
  const normalized = crm.normalizePartnerName(rawName);
  const soughtCanonicalKey = normalized.canonicalKey;
  if (soughtCanonicalKey === null) return undefined;
  // The lookup shape: the stored canonical key, the stored aliases, and the
  // row to parse. Match on those RAW values -- parsing first would strip the key.
  const lookupRows: PartnerLookupRow[] = (
    await listPartnerRowsPostgres(requireSql(context), tenantId)
  ).map((row) => ({
    // Phase A backfill rows carry no canonical_key; derive it from the name.
    canonicalKey:
      row.canonicalKey ??
      crm.normalizePartnerName(String(row.candidate["canonicalName"] ?? "")).canonicalKey,
    aliases: row.aliases,
    stored: row.candidate,
  }));
  const canonicalNameMatch = lookupRows.find((lookupRow) => lookupRow.canonicalKey === soughtCanonicalKey);
  const aliasMatch = lookupRows.find((lookupRow) =>
    lookupRow.aliases.some(
      (alias) => crm.normalizePartnerName(alias).canonicalKey === soughtCanonicalKey,
    ),
  );
  const matchingRow = canonicalNameMatch ?? aliasMatch;
  return matchingRow ? parseStoredPartner(matchingRow.stored) : undefined;
}

interface PartnerLookupRow {
  canonicalKey: string | null;
  aliases: string[];
  stored: Record<string, unknown>;
}

/**
 * The single place a stored partner row becomes a domain Partner.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so a partner row that no longer satisfies PartnerSchema answered
 * 500 from every read. Typed as CorruptRecordError it answers 409, and
 * listPartners can then catch precisely this and let everything else propagate.
 */
function parseStoredPartner(partnerItem: Record<string, unknown>): crm.Partner {
  return parseStoredRecord(
    crm.PartnerSchema,
    "Partner",
    storedRecordId(partnerItem, "partnerId"),
    stripStorageKeys(partnerItem),
  );
}

export interface UpdatePartnerContactInput {
  /** `null` clears the field; `undefined` leaves it alone. */
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactWhatsapp?: string | null;
}

/**
 * The desk types a vendor's email onto the system by hand (owner, 2026-09-25),
 * usually well after the partner was created by the importer with no contact
 * details at all. Only the three contact fields move; the name, aliases and
 * type have their own rules and stay exactly as stored.
 */
export async function updatePartnerContact(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  input: UpdatePartnerContactInput,
): Promise<crm.Partner> {
  const sql = requireSql(context);
  const partnerRow = await getPartnerRowPostgres(sql, tenantId, partnerId);
  if (!partnerRow) throw notFound("Partner");
  const currentPartner = parseStoredPartner(partnerRow.candidate);

  const { contactEmail: _email, contactPhone: _phone, contactWhatsapp: _whatsapp, ...partnerWithoutContact } = currentPartner;
  const resolveField = (next: string | null | undefined, current: string | undefined): string | undefined =>
    next === undefined ? current : next === null ? undefined : next;
  const contactEmail = resolveField(input.contactEmail, currentPartner.contactEmail);
  const contactPhone = resolveField(input.contactPhone, currentPartner.contactPhone);
  const contactWhatsapp = resolveField(input.contactWhatsapp, currentPartner.contactWhatsapp);

  const updatedPartner = crm.PartnerSchema.parse({
    ...partnerWithoutContact,
    ...(contactEmail !== undefined ? { contactEmail } : {}),
    ...(contactPhone !== undefined ? { contactPhone } : {}),
    ...(contactWhatsapp !== undefined ? { contactWhatsapp } : {}),
  });

  await updatePartnerContactPostgres(sql, updatedPartner, context.now().toISOString());
  return updatedPartner;
}
