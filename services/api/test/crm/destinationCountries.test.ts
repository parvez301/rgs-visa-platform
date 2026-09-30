import { describe, expect, it } from "vitest";
import { COUNTRY_PRODUCTS } from "@rgs/shared";
import { buildTestContext } from "../helpers";
import { listDestinationCountries } from "../../src/domain/crm/destinationCountries";
import {
  listCountryChecklists,
  putCountryChecklist,
  putCountryChecklistIfAbsent,
} from "../../src/domain/crm/countryChecklist";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("listDestinationCountries", () => {
  it("returns unique country codes with full names, sorted by name", async () => {
    const destinations = await listDestinationCountries(buildTestContext());
    expect(destinations.length).toBeGreaterThan(0);

    const codes = destinations.map((destination) => destination.countryCode);
    expect(new Set(codes).size).toBe(codes.length);

    for (const destination of destinations) {
      expect(destination.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(destination.countryName.length).toBeGreaterThan(2);
      // Not just the ISO code as the label.
      expect(destination.countryName).not.toBe(destination.countryCode);
    }

    const names = destinations.map((destination) => destination.countryName);
    const sortedNames = [...names].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    );
    expect(names).toEqual(sortedNames);

    const seedUae = COUNTRY_PRODUCTS.find((product) => product.countryCode === "AE");
    expect(seedUae).toBeDefined();
    expect(destinations.some((destination) => destination.countryCode === "AE")).toBe(true);
  });
});

describe("country checklist list + ifAbsent", () => {
  it("lists only stored checklists for the given codes", async () => {
    const context = buildTestContext();
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "JP", requiredDocuments: ["Passport"] },
      ACTOR,
    );

    const listed = await listCountryChecklists(context, TENANT_ID, ["JP", "AE"]);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.countryCode).toBe("JP");
  });

  it("putCountryChecklistIfAbsent inserts once and skips the second call", async () => {
    const context = buildTestContext();
    const first = await putCountryChecklistIfAbsent(
      context,
      TENANT_ID,
      { countryCode: "TH", requiredDocuments: ["Passport bio page", "Photo"] },
      ACTOR,
    );
    const second = await putCountryChecklistIfAbsent(
      context,
      TENANT_ID,
      { countryCode: "TH", requiredDocuments: ["Should not win"] },
      ACTOR,
    );
    expect(first).toBe("inserted");
    expect(second).toBe("skipped");

    const listed = await listCountryChecklists(context, TENANT_ID, ["TH"]);
    expect(listed[0]?.requiredDocuments).toEqual(["Passport bio page", "Photo"]);
  });
});
