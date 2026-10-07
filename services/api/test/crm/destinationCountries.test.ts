import { afterEach, describe, expect, it } from "vitest";
import { COUNTRY_PRODUCTS, getCountryProduct, ISO_COUNTRIES, labelsForCountryCode } from "@rgs/shared";
import { buildTestContext, closeTestContexts } from "../helpers";
import { listDestinationCountries } from "../../src/domain/crm/destinationCountries";
import { upsertCountryProduct } from "../../src/domain/config";

afterEach(closeTestContexts);

const ADMIN_ID = "admin_1";
const ADMIN_EMAIL = "admin@rgs.test";

describe("listDestinationCountries", () => {
  it("returns every ISO country with full names, sorted by name", async () => {
    const destinations = await listDestinationCountries(await buildTestContext());
    expect(destinations).toHaveLength(ISO_COUNTRIES.length);

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

    expect(destinations.some((destination) => destination.countryCode === "AE")).toBe(true);
    // Countries with no Config product still appear (full world list).
    expect(destinations.some((destination) => destination.countryCode === "BR")).toBe(true);
  });

  it("prefers Config country names over the ISO short name", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...getCountryProduct("AE"),
      countryName: "United Arab Emirates (RGS)",
      active: false,
    });

    const destinations = await listDestinationCountries(context);
    expect(destinations.find((destination) => destination.countryCode === "AE")?.countryName).toBe(
      "United Arab Emirates (RGS)",
    );
  });

  // The New case drawer previews the stamp from this route, because the Config
  // catalog route is gated on a screen Ops and Finance cannot open.
  it("carries the same document labels create-case will stamp", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...getCountryProduct("AE"),
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Emirates ID copy" },
      ],
    });

    const destinations = await listDestinationCountries(context);
    const uae = destinations.find((destination) => destination.countryCode === "AE");
    expect(uae?.requiredDocuments).toEqual(["Passport bio page", "Emirates ID copy"]);
  });

  it("previews an empty list for a country with no documents configured", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...getCountryProduct("AE"),
      tier: "INFO_ONLY",
      requiredDocuments: [],
    });

    const destinations = await listDestinationCountries(context);
    expect(
      destinations.find((destination) => destination.countryCode === "AE")?.requiredDocuments,
    ).toEqual([]);
  });

  it("applies the shared merge rule, not its own", async () => {
    const context = await buildTestContext();
    const destinations = await listDestinationCountries(context);
    for (const destination of destinations) {
      expect(destination.requiredDocuments, destination.countryCode).toEqual(
        labelsForCountryCode(COUNTRY_PRODUCTS, destination.countryCode),
      );
    }
  });
});
