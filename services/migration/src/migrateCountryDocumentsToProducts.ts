import { z } from "zod";
import {
  DOC_TYPES,
  RequiredDocumentSchema,
  docTypeForLabel,
  requiredDocumentsFromLegacyDocTypes,
  type DocType,
  type RequiredDocument,
} from "@rgs/shared";
import { findCountryChecklist } from "@rgs/api/src/domain/crm/countryChecklist";
import type { AppContext } from "@rgs/api/src/lib/context";
import { logActivity } from "@rgs/api/src/lib/context";
import { stripStorageKeys } from "@rgs/api/src/lib/storedRecords";

// Mirrors the private keys in @rgs/api domain/config.ts (CONFIG#COUNTRY / `${countryCode}#${productCode}`).
const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

export interface MigrateCountryDocumentsReport {
  productsUpdated: number;
  productsSkippedAlreadyMigrated: number;
  /** Checklist labels written into products; a checklist shared by N products of one country counts N times. */
  checklistLabelsMerged: number;
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
function requiredDocumentsFromChecklistLabels(checklistLabels: readonly string[]): RequiredDocument[] {
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
 * One-time (idempotent) migrate: CRM country checklists + portal `docsRequired`
 * → `CountryProduct.requiredDocuments`.
 *
 * Reads raw CONFIG#COUNTRY rows (not `listCountryConfig`) so legacy
 * `docsRequired` rows are seen as stored. A country's checklist, when it has
 * labels, replaces the product's baseline wholesale; otherwise the baseline
 * (`docsRequired`) is converted label-for-label. `docsRequired` is dropped on
 * write. Already-converted rows are skipped. Checklist rows are left in place.
 */
export async function migrateCountryDocumentsToProducts(
  context: AppContext,
  tenantId: string,
  actorEmail: string,
): Promise<MigrateCountryDocumentsReport> {
  const storedItems = await context.table.query(CONFIG_PARTITION_KEY);
  const checklistLabelsByCountry = new Map<string, readonly string[]>();

  async function checklistLabelsFor(countryCode: string): Promise<readonly string[]> {
    const cachedLabels = checklistLabelsByCountry.get(countryCode);
    if (cachedLabels !== undefined) return cachedLabels;
    const checklist = await findCountryChecklist(context, tenantId, countryCode);
    const labels = checklist?.requiredDocuments ?? [];
    checklistLabelsByCountry.set(countryCode, labels);
    return labels;
  }

  const report: MigrateCountryDocumentsReport = {
    productsUpdated: 0,
    productsSkippedAlreadyMigrated: 0,
    checklistLabelsMerged: 0,
  };

  for (const storedItem of storedItems) {
    const product = parseCountryProductForMigration(storedItem);
    const isLegacyRow = product.legacyDocTypes !== undefined;
    if (!isLegacyRow && (product.requiredDocuments?.length ?? 0) > 0) {
      report.productsSkippedAlreadyMigrated += 1;
      continue;
    }

    const baselineDocuments =
      product.legacyDocTypes !== undefined
        ? requiredDocumentsFromLegacyDocTypes(product.legacyDocTypes)
        : (product.requiredDocuments ?? []);
    const checklistDocuments = requiredDocumentsFromChecklistLabels(
      await checklistLabelsFor(product.countryCode),
    );
    const mergedDocuments = checklistDocuments.length > 0 ? checklistDocuments : baselineDocuments;

    // A converted row with nothing to add (no checklist, empty baseline) has no work left.
    if (!isLegacyRow && checklistDocuments.length === 0) {
      report.productsSkippedAlreadyMigrated += 1;
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
