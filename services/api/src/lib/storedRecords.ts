import { ZodError, type ZodType } from "zod";
import { CorruptRecordError, corruptRecord } from "./errors";

/**
 * The one place a stored DynamoDB row becomes a domain object, and the one
 * place a listing decides what to do when it will not.
 *
 * This module exists because naming instances is not fixing a class. The
 * defect (C3) is that `items.map(itemToThing)` where `itemToThing` ends in a
 * bare `schema.parse()` throws a ZodError; `http/router.ts` maps only
 * `ApiError` subclasses, so ONE malformed stored row answers 500 for an
 * ENTIRE listing. The first fix round patched the three paths a review
 * happened to enumerate and left five live, including the unauthenticated
 * `GET /api/v1/notices` that every visitor to the public website hits.
 *
 * So the rule is now structural rather than remembered: every collection read
 * path in this service parses through `parseStoredRecord` and iterates
 * through `collectReadableRecords`. A new listing that forgets is a listing
 * that does not compile against these types, not one that 500s in production.
 *
 * The cost is accepted deliberately: a listing can now hide a corrupt row
 * behind a soft failure instead of announcing it loudly. That is why the id
 * of every skipped row travels back to the caller in the response — a
 * `console.warn` nobody is watching does not make a missing row visible to
 * the operator looking at the screen it is missing from — and why only
 * `CorruptRecordError` is swallowed. Every other failure still propagates.
 */

/** Attribute names DynamoDB storage owns; no domain schema expects them. */
const STORAGE_KEY_ATTRIBUTES = [
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "GSI2PK",
  "GSI2SK",
  "GSI3PK",
  "GSI3SK",
] as const;

/** A stored row with its storage keys removed, ready for a domain schema. */
export function stripStorageKeys(
  storedItem: Record<string, unknown>,
): Record<string, unknown> {
  const domainAttributes: Record<string, unknown> = {};
  for (const [attributeName, attributeValue] of Object.entries(storedItem)) {
    if ((STORAGE_KEY_ATTRIBUTES as readonly string[]).includes(attributeName)) continue;
    domainAttributes[attributeName] = attributeValue;
  }
  return domainAttributes;
}

/**
 * The first schema complaint, in the words an operator can act on. Seven
 * byte-identical copies of this lived beside seven `.parse()` call sites.
 */
export function describeFirstZodIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
}

/**
 * The id that names a stored row.
 *
 * The body carries it, but a row that lost it is exactly the kind of row this
 * path exists for, and `String(undefined)` would report the literal id
 * "undefined" — which finds nothing. The storage key always names the row, so
 * it is the fallback.
 */
export function storedRecordId(
  storedItem: Record<string, unknown>,
  idAttributeName: string,
): string {
  const idFromBody = storedItem[idAttributeName];
  if (typeof idFromBody === "string" && idFromBody.length > 0) return idFromBody;
  const partitionKey = storedItem["PK"];
  const sortKey = storedItem["SK"];
  if (typeof partitionKey === "string" && typeof sortKey === "string") {
    return `${partitionKey} / ${sortKey}`;
  }
  return String(partitionKey ?? sortKey ?? "an unidentifiable row");
}

/**
 * Parses one stored row into a domain object, turning a schema failure into a
 * `CorruptRecordError` that names the row.
 *
 * Raw, a ZodError is not an ApiError and `router.ts` maps only ApiError
 * subclasses, so a single half-written partition answered 500. Typed as
 * CorruptRecordError it answers 409 naming the row, and a listing can catch
 * precisely this and skip.
 */
export function parseStoredRecord<SchemaType extends ZodType>(
  schema: SchemaType,
  entityDescription: string,
  recordId: string,
  storedAttributes: unknown,
): SchemaType["_output"] {
  try {
    return schema.parse(storedAttributes);
  } catch (error) {
    if (error instanceof ZodError) {
      throw corruptRecord(entityDescription, recordId, describeFirstZodIssue(error));
    }
    throw error;
  }
}

/**
 * A listing plus the ids of the rows it could not read. The skipped ids travel
 * with the payload on purpose: a record that silently drops out of a listing
 * is indistinguishable from a record that was never there.
 */
export interface ReadableCollection<RecordType> {
  records: RecordType[];
  unreadableRecordIds: string[];
}

export interface CollectReadableOptions {
  /** What one row is, in a warning an operator reads: "CRM partner". */
  entityDescription: string;
  /** Where it lives, when that narrows the search: "tenant rgs". */
  scopeDescription?: string;
}

/**
 * Turns stored rows into domain records, skipping — and naming — any row that
 * will not reassemble.
 *
 * `readStoredItem` may be async: a case is spread across a META item and its
 * applicant items, so reassembling one is a read of its own.
 */
export async function collectReadableRecords<StoredItemType, RecordType>(
  storedItems: readonly StoredItemType[],
  readStoredItem: (storedItem: StoredItemType) => RecordType | Promise<RecordType>,
  options: CollectReadableOptions,
): Promise<ReadableCollection<RecordType>> {
  const records: RecordType[] = [];
  const unreadableRecordIds: string[] = [];
  for (const storedItem of storedItems) {
    try {
      records.push(await readStoredItem(storedItem));
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      unreadableRecordIds.push(error.recordId);
      console.warn(describeSkippedRecord(error, options));
    }
  }
  return { records, unreadableRecordIds };
}

function describeSkippedRecord(
  error: CorruptRecordError,
  options: CollectReadableOptions,
): string {
  const scopeSuffix =
    options.scopeDescription === undefined ? "" : ` in ${options.scopeDescription}`;
  return `Skipped unreadable ${options.entityDescription} ${error.recordId}${scopeSuffix}: ${error.reason}`;
}
