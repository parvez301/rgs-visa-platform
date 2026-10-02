import { requiredDocumentsFromLegacyDocTypes, type CountryProduct } from "@rgs/shared";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { itemToCountryProduct } from "@rgs/api/src/domain/config";
import { upsertCountryProductPostgres } from "@rgs/api/src/domain/configCountryProductsPostgres";
import { DEFAULT_TENANT_ID, META_SORT_KEY, countryChecklistPartitionKey } from "@rgs/api/src/domain/crm/keys";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { parseStoredRecord, stripStorageKeys } from "@rgs/api/src/lib/storedRecords";
import { describeError, isRecordLevelDatabaseError } from "./backfillCrmRemainingToPostgres";
import { CountryChecklistSchema } from "./countryChecklistSchema";
import {
  type CountryProductForMigration,
  mergeChecklistIntoDocuments,
  parseCountryProductForMigration,
  requiredDocumentsFromChecklistLabels,
} from "./migrateCountryDocumentsToProducts";

// Mirrors the private key in @rgs/api domain/config.ts (CONFIG#COUNTRY / `${countryCode}#${productCode}`).
const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

export interface BackfillCountryCatalogResult {
  productsUpserted: number;
  /** Countries whose leftover Dynamo checklist was folded into at least one product. */
  checklistCountriesMerged: number;
  /** `countryCode#productCode` (or the storage key) of rows that would not read or that Postgres rejected. */
  unreadableProductIds: string[];
  /** Countries whose checklist row is unreadable, or whose merged product failed validation; not merged. */
  unreadableChecklistCountryCodes: string[];
}

export interface BackfillCountryCatalogOptions {
  table: TableClient;
  sql: SqlClient;
  /** Tenant the legacy checklist rows live under. Defaults to the single production tenant. */
  tenantId?: string;
  /** Called once per product copied, so a large run is not silent. */
  onProgress?: (label: string, n: number) => void;
}

function storedRowName(storedItem: TableItem): string {
  const countryCode = storedItem["countryCode"];
  const productCode = storedItem["productCode"];
  if (typeof countryCode === "string" && typeof productCode === "string") {
    return `${countryCode}#${productCode}`;
  }
  return String(storedItem["SK"] ?? storedItem["PK"] ?? "an unidentifiable row");
}

/**
 * Copies the Dynamo country catalog (`CONFIG#COUNTRY`) into `crm_country_products`
 * (migration 005) -- the table `CRM_STORE=postgres` reads -- and folds any
 * leftover CRM country checklists into the products on the way. Reads Dynamo
 * regardless of `CRM_STORE`.
 *
 * Each row is read exactly as the live Dynamo listing reads it
 * (`itemToCountryProduct`: legacy `docsRequired` coercion, seed-default heal),
 * then upserted on `(country_code, product_code)`, so a desk edit in Dynamo
 * beats the seed row migration 005 created. Rows Dynamo does not hold keep the
 * seed.
 *
 * Checklist fold uses `mergeChecklistIntoDocuments`, the same rule as
 * the retired Dynamo-era migration: a legacy row, or a converted row with no
 * documents, takes the checklist's labels; a converted row that already has
 * documents is left alone. An unreadable checklist names its country and skips
 * the merge (the product is still copied unmerged).
 *
 * Idempotent: Dynamo is only read, every write is an upsert. Only safe before
 * cutover -- afterwards Postgres holds newer rows a re-run would overwrite.
 * A row that cannot be copied is named in the result, never silently dropped:
 * cutover needs both `unreadable*` lists empty.
 */
export async function backfillCountryCatalogToPostgres(
  options: BackfillCountryCatalogOptions,
): Promise<BackfillCountryCatalogResult> {
  const { table, sql, onProgress } = options;
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const result: BackfillCountryCatalogResult = {
    productsUpserted: 0,
    checklistCountriesMerged: 0,
    unreadableProductIds: [],
    unreadableChecklistCountryCodes: [],
  };

  await applyMigrations(sql);

  const checklistLabelsByCountry = new Map<string, readonly string[] | "CORRUPT">();
  async function checklistLabelsFor(countryCode: string): Promise<readonly string[] | "CORRUPT"> {
    const cachedLabels = checklistLabelsByCountry.get(countryCode);
    if (cachedLabels !== undefined) return cachedLabels;
    let labels: readonly string[] | "CORRUPT";
    const checklistItem = await table.get(countryChecklistPartitionKey(tenantId, countryCode), META_SORT_KEY);
    if (checklistItem === undefined) {
      labels = [];
    } else {
      try {
        labels = parseStoredRecord(
          CountryChecklistSchema,
          "CountryChecklist",
          countryCode,
          stripStorageKeys(checklistItem),
        ).requiredDocuments;
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        console.warn(`Skipping unreadable country checklist ${countryCode}: ${error.reason}`);
        labels = "CORRUPT";
        result.unreadableChecklistCountryCodes.push(countryCode);
      }
    }
    checklistLabelsByCountry.set(countryCode, labels);
    return labels;
  }

  const mergedCountries = new Set<string>();
  const skipProduct = (rowName: string, reason: string): void => {
    console.warn(`Skipping unreadable country product ${rowName}: ${reason}`);
    result.unreadableProductIds.push(rowName);
  };

  const storedItems = await table.query(CONFIG_PARTITION_KEY, { consistentRead: true });
  for (const storedItem of storedItems) {
    let rowName = storedRowName(storedItem);

    // parseCountryProductForMigration throws a plain Error naming the row when it cannot even be identified.
    let migrationView: CountryProductForMigration;
    try {
      migrationView = parseCountryProductForMigration(storedItem);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      skipProduct(rowName, error.message);
      continue;
    }
    rowName = `${migrationView.countryCode}#${migrationView.productCode}`;

    let product: CountryProduct;
    let mergedFromChecklist = false;
    try {
      product = itemToCountryProduct(storedItem);

      const isLegacyRow = migrationView.legacyDocTypes !== undefined;
      const baselineDocuments =
        migrationView.legacyDocTypes !== undefined
          ? requiredDocumentsFromLegacyDocTypes(migrationView.legacyDocTypes)
          : (migrationView.requiredDocuments ?? []);
      // Same short-circuit as the migration: a converted row with documents never reads the checklist.
      if (isLegacyRow || baselineDocuments.length === 0) {
        const checklistLabels = await checklistLabelsFor(migrationView.countryCode);
        const checklistDocuments =
          checklistLabels === "CORRUPT" ? [] : requiredDocumentsFromChecklistLabels(checklistLabels);
        const mergedDocuments = mergeChecklistIntoDocuments({ isLegacyRow, baselineDocuments, checklistDocuments });
        if (mergedDocuments !== undefined && checklistDocuments.length > 0) {
          try {
            product = itemToCountryProduct({ ...stripStorageKeys(storedItem), requiredDocuments: mergedDocuments });
            mergedFromChecklist = true;
          } catch (error) {
            if (!(error instanceof CorruptRecordError)) throw error;
            console.warn(`Country checklist ${migrationView.countryCode} not merged into ${rowName}: ${error.reason}`);
            if (!result.unreadableChecklistCountryCodes.includes(migrationView.countryCode)) {
              result.unreadableChecklistCountryCodes.push(migrationView.countryCode);
            }
          }
        }
      }
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      skipProduct(rowName, error.reason);
      continue;
    }

    try {
      await upsertCountryProductPostgres(sql, product);
    } catch (error) {
      if (!isRecordLevelDatabaseError(error)) throw error;
      skipProduct(rowName, describeError(error));
      continue;
    }
    if (mergedFromChecklist) mergedCountries.add(migrationView.countryCode);
    result.productsUpserted += 1;
    onProgress?.("products", result.productsUpserted);
  }
  result.checklistCountriesMerged = mergedCountries.size;

  return result;
}
