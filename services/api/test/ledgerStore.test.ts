import { describe, expect, it } from "vitest";
import { ledgerStoreFromEnvironment } from "../src/lib/sql";

describe("ledgerStoreFromEnvironment", () => {
  it("defaults to dynamo", () => {
    expect(ledgerStoreFromEnvironment({})).toBe("dynamo");
  });
  it("accepts postgres", () => {
    expect(ledgerStoreFromEnvironment({ LEDGER_STORE: "postgres" })).toBe("postgres");
  });
  it("rejects unknown values", () => {
    expect(() => ledgerStoreFromEnvironment({ LEDGER_STORE: "banana" })).toThrow(/LEDGER_STORE/);
  });
});
