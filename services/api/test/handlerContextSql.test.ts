import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnv = {
  TABLE_NAME: "rgs-table",
  DOCUMENTS_BUCKET: "rgs-documents",
  EMAIL_SENDER: "noreply@rgs.test",
  ADMIN_NOTIFICATION_EMAIL: "info@rgs.test",
};

describe("buildProductionContext sql wiring", () => {
  let savedEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnvironment = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnvironment;
    vi.restoreAllMocks();
  });

  it("throws when LEDGER_STORE=postgres but DATABASE_URL is missing", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["LEDGER_STORE"] = "postgres";
    delete process.env["CRM_STORE"];
    delete process.env["DATABASE_URL"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/DATABASE_URL/);
  });

  it("throws when CRM_STORE=postgres but DATABASE_URL is missing", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["CRM_STORE"] = "postgres";
    delete process.env["LEDGER_STORE"];
    delete process.env["DATABASE_URL"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/CRM_STORE is postgres but DATABASE_URL/);
  });

  it("attaches sql when DATABASE_URL is set", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["DATABASE_URL"] = "postgresql://user:pass@localhost:6543/postgres";
    delete process.env["LEDGER_STORE"];

    const { buildProductionContext } = await import("../src/http/handler");
    const context = buildProductionContext();

    expect(context.sql).toBeDefined();
    expect(typeof context.sql?.query).toBe("function");
    await context.sql?.end();
  });
});
