import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import {
  CorruptRecordError,
  badRequest,
  conflict,
  corruptRecord,
  notFound,
} from "../../lib/errors";
import { newId } from "../../lib/ids";
import { META_SORT_KEY, partnerListGsi1Pk, partnerPartitionKey } from "./keys";

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

  await context.table.put({
    PK: partnerPartitionKey(tenantId, partner.partnerId),
    SK: META_SORT_KEY,
    GSI1PK: partnerListGsi1Pk(tenantId),
    // The canonical key is a storage attribute only — PartnerSchema has no such
    // field, so it must not be spread into the domain object.
    GSI1SK: normalized.canonicalKey,
    ...partner,
  });
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
  const partnerItems = await context.table.queryGsi("GSI1", partnerListGsi1Pk(tenantId));
  const loadedPartners: crm.Partner[] = [];
  const unreadablePartnerIds: string[] = [];
  for (const partnerItem of partnerItems) {
    try {
      loadedPartners.push(parseStoredPartner(partnerItem));
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      unreadablePartnerIds.push(error.recordId);
      console.warn(
        `Skipped unreadable CRM partner ${error.recordId} in tenant ${tenantId}: ${error.reason}`,
      );
    }
  }
  return { partners: loadedPartners, unreadablePartnerIds };
}

export async function getPartnerOrThrow(
  context: AppContext,
  tenantId: string,
  partnerId: string,
): Promise<crm.Partner> {
  const partnerItem = await context.table.get(partnerPartitionKey(tenantId, partnerId), META_SORT_KEY);
  if (!partnerItem) throw notFound("Partner");
  return parseStoredPartner(partnerItem);
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
  const partnerItems = await context.table.queryGsi("GSI1", partnerListGsi1Pk(tenantId));
  // Match on the RAW item's GSI1SK. Parsing first would strip the key.
  const canonicalNameMatch = partnerItems.find(
    (partnerItem) => partnerItem.GSI1SK === soughtCanonicalKey,
  );
  const aliasMatch = partnerItems.find((partnerItem) =>
    storedAliasesOf(partnerItem).some(
      (alias) => crm.normalizePartnerName(alias).canonicalKey === soughtCanonicalKey,
    ),
  );
  const matchingItem = canonicalNameMatch ?? aliasMatch;
  return matchingItem ? parseStoredPartner(matchingItem) : undefined;
}

/**
 * The single place a stored partner item becomes a domain Partner.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so a partner row that no longer satisfies PartnerSchema answered
 * 500 from every read. Typed as CorruptRecordError it answers 409, exactly as
 * readCase already does for a case partition that will not reassemble, and
 * listPartners can then catch precisely this and let everything else propagate.
 */
function parseStoredPartner(partnerItem: TableItem): crm.Partner {
  try {
    return crm.PartnerSchema.parse(stripKeys(partnerItem));
  } catch (error) {
    if (error instanceof ZodError) {
      throw corruptRecord("Partner", partnerIdOfStoredItem(partnerItem), describeFirstIssue(error));
    }
    throw error;
  }
}

/**
 * The id that names a stored partner row. The body carries it, but a row that
 * lost it is exactly the kind of row this path exists for, and
 * String(undefined) would report the literal id "undefined" — which finds
 * nothing. The storage key always names the row, so it is the fallback.
 */
function partnerIdOfStoredItem(partnerItem: TableItem): string {
  const storedPartnerId = partnerItem["partnerId"];
  if (typeof storedPartnerId === "string" && storedPartnerId.length > 0) {
    return storedPartnerId;
  }
  return partnerItem.PK;
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
}

/** The aliases on a raw stored item, ignoring anything that is not a string. */
function storedAliasesOf(partnerItem: Record<string, unknown>): string[] {
  const storedAliases = partnerItem["aliases"];
  if (!Array.isArray(storedAliases)) return [];
  return storedAliases.filter((alias): alias is string => typeof alias === "string");
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1Pk,
    GSI1SK: _gsi1Sk,
    ...domainFields
  } = item;
  return domainFields;
}
