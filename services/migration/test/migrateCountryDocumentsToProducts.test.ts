import { describe, expect, it } from "vitest";
import { parseCountryProductForMigration } from "../src/migrateCountryDocumentsToProducts";
import { runMigrateCountryDocumentsToProductsCli } from "../src/runMigrateCountryDocumentsToProductsCli";

const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

describe("parseCountryProductForMigration", () => {
  it("accepts the legacy shape and strips storage keys and docsRequired", () => {
    const parsed = parseCountryProductForMigration({
      PK: CONFIG_PARTITION_KEY,
      SK: "AE#AE-E-VISA",
      countryCode: "AE",
      productCode: "AE-E-VISA",
      docsRequired: ["PASSPORT_BIO"],
    });
    expect(parsed.legacyDocTypes).toEqual(["PASSPORT_BIO"]);
    expect(parsed.requiredDocuments).toBeUndefined();
    expect(parsed.attributes).toEqual({ countryCode: "AE", productCode: "AE-E-VISA" });
  });

  it("accepts the new shape", () => {
    const parsed = parseCountryProductForMigration({
      PK: CONFIG_PARTITION_KEY,
      SK: "AE#AE-E-VISA",
      countryCode: "AE",
      productCode: "AE-E-VISA",
      requiredDocuments: [{ label: "Custom letter" }],
    });
    expect(parsed.legacyDocTypes).toBeUndefined();
    expect(parsed.requiredDocuments).toEqual([{ label: "Custom letter" }]);
  });

  it("names the row when docsRequired holds an unknown doc type", () => {
    expect(() =>
      parseCountryProductForMigration({
        PK: CONFIG_PARTITION_KEY,
        SK: "AE#AE-E-VISA",
        countryCode: "AE",
        productCode: "AE-E-VISA",
        docsRequired: ["NOT_A_DOC"],
      }),
    ).toThrow(/AE#AE-E-VISA.*docsRequired/);
  });
});

describe("runMigrateCountryDocumentsToProductsCli (retired)", () => {
  it("exits 1 and points operators at backfill:country-catalog-postgres", () => {
    const errorLines: string[] = [];

    const { exitCode } = runMigrateCountryDocumentsToProductsCli({
      logError: (message) => errorLines.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("backfill:country-catalog-postgres");
  });
});
