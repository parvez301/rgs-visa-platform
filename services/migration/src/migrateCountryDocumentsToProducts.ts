import { z } from "zod";
import {
  CountryProductSchema,
  DOC_TYPES,
  RequiredDocumentSchema,
  docTypeForLabel,
  requiredDocumentsFromLegacyDocTypes,
  type DocType,
  type RequiredDocument,
} from "@rgs/shared";
import { findCountryChecklist } from "@rgs/api/src/domain/crm/countryChecklist";
import type { AppContext } from "@rgs/api/src/lib/context";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import { logActivity } from "@rgs/api/src/lib/context";
import { stripStorageKeys } from "@rgs/api/src/lib/storedRecords";

// Mirrors the private keys in @rgs/api domain/config.ts (CONFIG#COUNTRY / `${countryCode}#${productCode}`).
const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

export interface MigrateCountryDocumentsReport {
  productsUpdated: number;
  productsSkippedAlreadyMigrated: number;
  /** Checklist labels written into products; a checklist shared by N products of one country counts N times. */
  checklistLabelsMerged: number;
  /**
   * Products whose merged result failed `CountryProductSchema` (duplicate label or
   * portalDocType, fulfilled country with no documents, ...). Left exactly as stored.
   */
  productsSkippedInvalid: number;
  /** One "countryCode#productCode: reason" line per invalid product, for the operator. */
  invalidProductDetails: string[];
  /** Countries whose checklist row is unreadable; their products are left unmigrated. */
  checklistsSkippedCorrupt: number;
  corruptChecklistCountryCodes: string[];
  /** Products left unmigrated because their country's checklist is unreadable. */
  productsSkippedCorruptChecklist: number;
}

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
 * The merge rule shared by the Dynamo-era migration and the Postgres backfill:
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

/**
 * One-time (idempotent) migrate: CRM country checklists + portal `docsRequired`
 * → `CountryProduct.requiredDocuments`.
 *
 * Reads raw CONFIG#COUNTRY rows (not `listCountryConfig`) so legacy
 * `docsRequired` rows are seen as stored. A country's checklist, when it has
 * labels, replaces the product's baseline wholesale; otherwise the baseline
 * (`docsRequired`) is converted label-for-label. `docsRequired` is dropped on
 * write. Already-converted rows are skipped. Checklist rows are left in place.
 *
 * A merged product that fails `CountryProductSchema`, or whose country
 * checklist is unreadable, does not block the rest: it is left exactly as
 * stored, counted and named in the report, and picked up by a re-run once the
 * data is fixed. A row the migration cannot even identify is different --
 * a missing `countryCode`/`productCode` or an unreadable `docsRequired`
 * throws and stops the run, naming the row, because guessing at a
 * half-written catalog row is worse than making an operator look at it.
 * Idempotency makes that re-run safe.
 */
export async function migrateCountryDocumentsToProducts(
  context: AppContext,
  tenantId: string,
  actorEmail: string,
): Promise<MigrateCountryDocumentsReport> {
  const storedItems = await context.table.query(CONFIG_PARTITION_KEY);
  const report: MigrateCountryDocumentsReport = {
    productsUpdated: 0,
    productsSkippedAlreadyMigrated: 0,
    checklistLabelsMerged: 0,
    productsSkippedInvalid: 0,
    invalidProductDetails: [],
    checklistsSkippedCorrupt: 0,
    corruptChecklistCountryCodes: [],
    productsSkippedCorruptChecklist: 0,
  };

  const checklistLabelsByCountry = new Map<string, readonly string[] | "CORRUPT">();

  /**
   * "CORRUPT" rather than a silent fallback to the baseline: converting the
   * product without the checklist would drop the desk's edits AND, because
   * converted rows are skipped on re-run, make that loss permanent.
   */
  async function checklistLabelsFor(countryCode: string): Promise<readonly string[] | "CORRUPT"> {
    const cachedLabels = checklistLabelsByCountry.get(countryCode);
    if (cachedLabels !== undefined) return cachedLabels;
    let labels: readonly string[] | "CORRUPT";
    try {
      const checklist = await findCountryChecklist(context, tenantId, countryCode);
      labels = checklist?.requiredDocuments ?? [];
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      labels = "CORRUPT";
      report.checklistsSkippedCorrupt += 1;
      report.corruptChecklistCountryCodes.push(countryCode);
    }
    checklistLabelsByCountry.set(countryCode, labels);
    return labels;
  }

  for (const storedItem of storedItems) {
    const product = parseCountryProductForMigration(storedItem);
    const isLegacyRow = product.legacyDocTypes !== undefined;
    if (!isLegacyRow && (product.requiredDocuments?.length ?? 0) > 0) {
      report.productsSkippedAlreadyMigrated += 1;
      continue;
    }

    const checklistLabels = await checklistLabelsFor(product.countryCode);
    if (checklistLabels === "CORRUPT") {
      report.productsSkippedCorruptChecklist += 1;
      continue;
    }

    const baselineDocuments =
      product.legacyDocTypes !== undefined
        ? requiredDocumentsFromLegacyDocTypes(product.legacyDocTypes)
        : (product.requiredDocuments ?? []);
    const checklistDocuments = requiredDocumentsFromChecklistLabels(checklistLabels);
    const mergedDocuments = mergeChecklistIntoDocuments({ isLegacyRow, baselineDocuments, checklistDocuments });

    // A converted row with nothing to add (no checklist, empty baseline) has no work left.
    if (mergedDocuments === undefined) {
      report.productsSkippedAlreadyMigrated += 1;
      continue;
    }

    const validation = CountryProductSchema.safeParse({
      ...product.attributes,
      requiredDocuments: mergedDocuments,
    });
    if (!validation.success) {
      const firstIssue = validation.error.issues[0];
      report.productsSkippedInvalid += 1;
      report.invalidProductDetails.push(
        `${product.countryCode}#${product.productCode}: ${
          firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "invalid country product"
        }`,
      );
      continue;
    }

    await context.table.put({
      PK: CONFIG_PARTITION_KEY,
      SK: String(storedItem["SK"]),
      ...product.attributes,
      requiredDocuments: mergedDocuments,
    });
    await logActivity(
      context,
      "CONFIG_CHANGED",
      actorEmail,
      undefined,
      {
        countryCode: product.countryCode,
        productCode: product.productCode,
        requiredDocumentCount: mergedDocuments.length,
        migratedFrom: checklistDocuments.length > 0 ? "checklist" : "docsRequired",
      },
      { actorEmail, actorRole: "admin" },
    );
    report.productsUpdated += 1;
    report.checklistLabelsMerged += checklistDocuments.length;
  }

  return report;
}
