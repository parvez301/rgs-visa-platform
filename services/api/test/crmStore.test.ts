import { describe, expect, it } from "vitest";
import { crmStoreFromEnvironment } from "../src/lib/sql";

describe("crmStoreFromEnvironment", () => {
  it("defaults to postgres", () => {
    expect(crmStoreFromEnvironment({})).toBe("postgres");
  });
  it("rejects dynamo", () => {
    expect(() => crmStoreFromEnvironment({ CRM_STORE: "dynamo" })).toThrow(
      /CRM_STORE must be postgres/,
    );
  });
  it("accepts postgres", () => {
    expect(crmStoreFromEnvironment({ CRM_STORE: "postgres" })).toBe("postgres");
  });
  it("rejects unknown values", () => {
    expect(() => crmStoreFromEnvironment({ CRM_STORE: "banana" })).toThrow(/CRM_STORE/);
  });
});
