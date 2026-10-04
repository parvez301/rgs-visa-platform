import { z } from "zod";
import {
  DOC_TYPES,
  RequiredDocumentSchema,
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
