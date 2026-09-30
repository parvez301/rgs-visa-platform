import { COUNTRY_PRODUCTS, type CountryProduct } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import {
  buildImportPreview,
  parseConfigCsv,
  serializeConfigCsv,
} from "../src/lib/configCsv";

const ae: CountryProduct = COUNTRY_PRODUCTS.find(
  (countryProduct) => countryProduct.countryCode === "AE",
)!;

function csvWithDocsCell(headerName: string, docsCell: string): string {
  const csv = serializeConfigCsv([ae]);
  const [headerLine, bodyLine] = csv.split("\n");
  const headers = headerLine!.split(",");
  const docsIndex = headers.indexOf("requiredDocuments");
  const renamedHeaders = headers.map((header, index) =>
    index === docsIndex ? headerName : header,
  );
  const cells = bodyLine!.split(",");
  // Seed AE row has no commas inside quoted cells except possibly the docs cell.
  const cellsWithoutDocs = cells.slice(0, docsIndex);
  const tail = cells.slice(cells.length - (headers.length - docsIndex - 1));
  return [
    renamedHeaders.join(","),
    [...cellsWithoutDocs, `"${docsCell.replaceAll('"', '""')}"`, ...tail].join(","),
  ].join("\n");
}

describe("configCsv requiredDocuments", () => {
  it("round-trips requiredDocuments through CSV", () => {
    const csv = serializeConfigCsv([
      {
        ...ae,
        requiredDocuments: [
          { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
          { label: "Custom" },
        ],
      },
    ]);
    const parsed = parseConfigCsv(csv);
    expect(parsed[0]?.validationError).toBeNull();
    expect(parsed[0]?.product?.requiredDocuments).toEqual([
      { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
      { label: "Custom" },
    ]);
  });

  it("exports Label|DOC_TYPE;Label in the requiredDocuments column", () => {
    const csv = serializeConfigCsv([
      {
        ...ae,
        requiredDocuments: [
          { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
          { label: "Custom" },
        ],
      },
    ]);
    expect(csv.split("\n")[0]).toContain("requiredDocuments");
    expect(csv.split("\n")[0]).not.toContain("docsRequired");
    expect(csv).toContain("Passport bio page|PASSPORT_BIO;Custom");
  });

  it("round-trips labels containing separators and commas", () => {
    const requiredDocuments = [
      { label: "Form A; signed, stamped | original", portalDocType: "PHOTO" as const },
      { label: "Back\\slash" },
    ];
    const parsed = parseConfigCsv(serializeConfigCsv([{ ...ae, requiredDocuments }]));
    expect(parsed[0]?.validationError).toBeNull();
    expect(parsed[0]?.product?.requiredDocuments).toEqual(requiredDocuments);
  });

  it("imports legacy enum-pipe cells via requiredDocumentsFromLegacyDocTypes", () => {
    const parsed = parseConfigCsv(csvWithDocsCell("docsRequired", "PASSPORT_BIO|PHOTO"));
    expect(parsed[0]?.validationError).toBeNull();
    expect(parsed[0]?.product?.requiredDocuments).toEqual([
      { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
      { label: "Passport-size photo", portalDocType: "PHOTO" },
    ]);
  });

  it("coerces a legacy enum-pipe cell under the requiredDocuments header too", () => {
    const parsed = parseConfigCsv(csvWithDocsCell("requiredDocuments", "PASSPORT_BIO|PHOTO"));
    expect(parsed[0]?.product?.requiredDocuments.map((doc) => doc.portalDocType)).toEqual([
      "PASSPORT_BIO",
      "PHOTO",
    ]);
  });

  it("rejects an unknown DocType after the pipe", () => {
    const parsed = parseConfigCsv(csvWithDocsCell("requiredDocuments", "Something|NOT_A_TYPE"));
    expect(parsed[0]?.product).toBeNull();
    expect(parsed[0]?.validationError).toMatch(/NOT_A_TYPE/);
  });

  it("marks reordered or relabelled documents as changed in the import preview", () => {
    const reordered = {
      ...ae,
      requiredDocuments: [...ae.requiredDocuments].reverse(),
    };
    const preview = buildImportPreview(parseConfigCsv(serializeConfigCsv([reordered])), [ae]);
    expect(preview[0]?.kind).toBe(ae.requiredDocuments.length > 1 ? "changed" : "unchanged");
    const same = buildImportPreview(parseConfigCsv(serializeConfigCsv([ae])), [ae]);
    expect(same[0]?.kind).toBe("unchanged");
    const relabelled = {
      ...ae,
      requiredDocuments: ae.requiredDocuments.map((doc, index) =>
        index === 0 ? { ...doc, label: `${doc.label} (new)` } : doc,
      ),
    };
    const relabelPreview = buildImportPreview(
      parseConfigCsv(serializeConfigCsv([relabelled])),
      [ae],
    );
    expect(relabelPreview[0]?.kind).toBe("changed");
  });
});
