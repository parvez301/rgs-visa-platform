import { z } from "zod";
import {
  DOC_TYPES,
  RequiredDocumentSchema,
  docTypeForLabel,
  type DocType,
  type RequiredDocument,
} from "@rgs/shared";
import { stripStorageKeys } from "@rgs/api/src/lib/storedRecords";

/**
 * A stored CONFIG#COUNTRY row as the migration sees it: either shape is
 * accepted, because the job runs against rows written before
 * `requiredDocuments` existed (still carrying `docsRequired`) as well as rows
 * that were already converted.
 */
export interface CountryProductForMigration {
  /** Every stored attribute except the storage keys and the legacy `docsRequired`. */
  attributes: Record<string, unknown>;
  countryCode: string;
  productCode: string;
  /** Present only while the row still carries the legacy `docsRequired` attribute. */
  legacyDocTypes?: DocType[];
  /** Present only when the row already stores `requiredDocuments`. */
  requiredDocuments?: RequiredDocument[];
}

const LegacyDocTypesSchema = z.array(z.enum(DOC_TYPES));
const RequiredDocumentsSchema = z.array(RequiredDocumentSchema);

export function parseCountryProductForMigration(
  rawItem: Record<string, unknown>,
): CountryProductForMigration {
  const { docsRequired, requiredDocumentLabels: _readTimeLabels, ...attributes } =
    stripStorageKeys(rawItem);
  const countryCode = attributes["countryCode"];
  const productCode = attributes["productCode"];
  if (typeof countryCode !== "string" || typeof productCode !== "string") {
    throw new Error(
      `Stored country product ${String(rawItem["SK"])} has no countryCode/productCode; fix or delete it before migrating`,
    );
  }
  const rowName = `${countryCode}#${productCode}`;

  const parsedProduct: CountryProductForMigration = { attributes, countryCode, productCode };
  if (docsRequired !== undefined) {
    const legacyParse = LegacyDocTypesSchema.safeParse(docsRequired);
    if (!legacyParse.success) {
      throw new Error(`Country product ${rowName} has an unreadable docsRequired: ${legacyParse.error.message}`);
    }
    parsedProduct.legacyDocTypes = legacyParse.data;
  }
  if (attributes["requiredDocuments"] !== undefined) {
    const requiredParse = RequiredDocumentsSchema.safeParse(attributes["requiredDocuments"]);
    if (!requiredParse.success) {
      throw new Error(
        `Country product ${rowName} has an unreadable requiredDocuments: ${requiredParse.error.message}`,
      );
    }
    parsedProduct.requiredDocuments = requiredParse.data;
  }
  return parsedProduct;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** Checklist order wins; known labels regain their portal upload slot, free text stays label-only. */
export function requiredDocumentsFromChecklistLabels(checklistLabels: readonly string[]): RequiredDocument[] {
  const requiredDocuments: RequiredDocument[] = [];
  const seenLabels = new Set<string>();
  for (const checklistLabel of checklistLabels) {
    const normalizedLabel = normalizeLabel(checklistLabel);
    if (normalizedLabel === "" || seenLabels.has(normalizedLabel)) continue;
    seenLabels.add(normalizedLabel);
    const portalDocType = docTypeForLabel(checklistLabel);
    requiredDocuments.push(
      portalDocType === undefined
        ? { label: checklistLabel.trim() }
        : { label: checklistLabel.trim(), portalDocType },
    );
  }
  return requiredDocuments;
}

/**
 * The checklist merge rule used by the Postgres backfill (the Dynamo-era
 * migration CLI that shared it has been retired):
 * a country's checklist, when it has labels, replaces the product's baseline
 * wholesale; otherwise a legacy row's baseline is kept (converted
 * label-for-label). Returns `undefined` when there is nothing to write -- the
 * row is already converted (it has documents, or it is converted and the
 * checklist adds none).
 */
export function mergeChecklistIntoDocuments(args: {
  isLegacyRow: boolean;
  baselineDocuments: readonly RequiredDocument[];
  checklistDocuments: readonly RequiredDocument[];
}): RequiredDocument[] | undefined {
  const { isLegacyRow, baselineDocuments, checklistDocuments } = args;
  if (!isLegacyRow && baselineDocuments.length > 0) return undefined;
  if (checklistDocuments.length > 0) return [...checklistDocuments];
  return isLegacyRow ? [...baselineDocuments] : undefined;
}
