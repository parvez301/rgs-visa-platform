import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnv = {
  DOCUMENTS_BUCKET: "rgs-documents",
  EMAIL_SENDER: "noreply@rgs.test",
  ADMIN_NOTIFICATION_EMAIL: "info@rgs.test",
  DATABASE_URL: "postgresql://user:pass@localhost:6543/postgres",
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

  it("boots with a Postgres client when legacy store flags are unset", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["CRM_STORE"];
    delete process.env["LEDGER_STORE"];

    const { buildProductionContext } = await import("../src/http/handler");
    const context = buildProductionContext();

    expect(context.sql).toBeDefined();
    expect(typeof context.sql?.query).toBe("function");
    await context.sql?.end();
  });

  it("boots with a Postgres client when legacy store flags are set", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["CRM_STORE"] = "postgres";
    process.env["LEDGER_STORE"] = "postgres";

    const { buildProductionContext } = await import("../src/http/handler");
    const context = buildProductionContext();

    expect(context.sql).toBeDefined();
    await context.sql?.end();
  });

  it("throws when DATABASE_URL is missing", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["DATABASE_URL"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/DATABASE_URL/);
  });

  it("throws when CRM store is dynamo", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["CRM_STORE"] = "dynamo";

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/CRM_STORE must be postgres/);
  });

  it("throws when LEDGER_STORE=dynamo", async () => {
    Object.assign(process.env, requiredEnv);
    process.env["LEDGER_STORE"] = "dynamo";

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/LEDGER_STORE must be postgres/);
  });

  it("throws when DOCUMENTS_BUCKET is missing without mentioning the legacy platform table env var", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["DOCUMENTS_BUCKET"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow();
    try {
      buildProductionContext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(new RegExp("TABLE" + "_NAME"));
    }
  });
});
