import { describe, expect, it } from "vitest";
import { COUNTRY_PRODUCTS } from "@rgs/shared";
import { catalogForStaticPages } from "../src/lib/buildCatalog";

describe("catalogForStaticPages", () => {
  it("keeps seed countries and prefers the live row when both exist", () => {
    const armeniaSeed = COUNTRY_PRODUCTS.find((product) => product.countryCode === "AM");
    expect(armeniaSeed).toBeDefined();
    expect(armeniaSeed?.active).toBe(false);

    const liveArmenia = { ...armeniaSeed!, active: true, serviceFeeInr: 1500 };
    const merged = catalogForStaticPages([liveArmenia]);
    const armenia = merged.find((product) => product.countryCode === "AM");
    expect(armenia?.active).toBe(true);
    expect(armenia?.serviceFeeInr).toBe(1500);
    expect(merged.length).toBe(COUNTRY_PRODUCTS.length);
  });
});
