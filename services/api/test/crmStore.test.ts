import { describe, expect, it } from "vitest";
import { crmStoreFromEnvironment } from "../src/lib/sql";

describe("crmStoreFromEnvironment", () => {
  it("defaults to dynamo", () => {
    expect(crmStoreFromEnvironment({})).toBe("dynamo");
  });
  it("accepts postgres", () => {
    expect(crmStoreFromEnvironment({ CRM_STORE: "postgres" })).toBe("postgres");
  });
  it("rejects unknown values", () => {
    expect(() => crmStoreFromEnvironment({ CRM_STORE: "banana" })).toThrow(/CRM_STORE/);
  });
});
