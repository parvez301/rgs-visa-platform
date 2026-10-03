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

  it("boots with postgres stores when store flags are unset", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["TABLE_NAME"];
    delete process.env["CRM_STORE"];
    delete process.env["LEDGER_STORE"];

    const { buildProductionContext } = await import("../src/http/handler");
    const context = buildProductionContext();

    expect(context.sql).toBeDefined();
    expect(typeof context.sql?.query).toBe("function");
    expect(context.crmStore).toBe("postgres");
    expect(context.ledgerStore).toBe("postgres");
    await context.sql?.end();
  });

  it("boots when CRM_STORE=postgres and LEDGER_STORE=postgres", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["TABLE_NAME"];
    process.env["CRM_STORE"] = "postgres";
    process.env["LEDGER_STORE"] = "postgres";

    const { buildProductionContext } = await import("../src/http/handler");
    const context = buildProductionContext();

    expect(context.sql).toBeDefined();
    expect(context.crmStore).toBe("postgres");
    expect(context.ledgerStore).toBe("postgres");
    await context.sql?.end();
  });

  it("throws when DATABASE_URL is missing", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["DATABASE_URL"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow(/DATABASE_URL/);
  });

  it("throws when CRM_STORE=dynamo", async () => {
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

  it("throws when DOCUMENTS_BUCKET is missing without mentioning TABLE_NAME", async () => {
    Object.assign(process.env, requiredEnv);
    delete process.env["DOCUMENTS_BUCKET"];

    const { buildProductionContext } = await import("../src/http/handler");
    expect(() => buildProductionContext()).toThrow();
    try {
      buildProductionContext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/TABLE_NAME/);
    }
  });
});
