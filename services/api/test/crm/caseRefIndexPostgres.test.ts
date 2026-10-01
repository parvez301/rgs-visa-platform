import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import {
  completeCaseRefReservation,
  readCaseRefReservation,
  reserveCaseRef,
} from "../../src/domain/crm/caseRefIndex";
import { caseRefIndexPartitionKey, META_SORT_KEY } from "../../src/domain/crm/keys";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const NOW_ISO = "2026-07-23T10:00:00.000Z";

describe("case ref reservations with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext({ seedStatusEmailTemplates: false });
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  it("reserves, reads back unfinished, then completes, leaving the Dynamo partition empty", async () => {
    const reserved = await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(reserved).toEqual({
      tenantId: TENANT_ID,
      caseRef: "31376",
      caseId: "case_1",
      reservedAt: NOW_ISO,
    });

    const unfinished = await readCaseRefReservation(context, TENANT_ID, "31376");
    expect(unfinished).toEqual(reserved);
    expect(unfinished!.completedAt).toBeUndefined();

    const completed = await completeCaseRefReservation(context, TENANT_ID, unfinished!);
    expect(completed.completedAt).toBe(NOW_ISO);
    expect(await readCaseRefReservation(context, TENANT_ID, "31376")).toEqual(completed);

    expect(await scalar<number>("select count(*)::int as value from crm_case_ref_reservations")).toBe(1);
    expect(
      await baseContext.table.get(caseRefIndexPartitionKey(TENANT_ID, "31376"), META_SORT_KEY),
    ).toBeUndefined();
  });

  it("upserts on (tenant, ref): completing never adds a second row", async () => {
    const reserved = await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    await completeCaseRefReservation(context, TENANT_ID, reserved);
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");

    expect(await scalar<number>("select count(*)::int as value from crm_case_ref_reservations")).toBe(1);
  });

  it("reports nothing for a ref nobody reserved, and keeps tenants apart", async () => {
    expect(await readCaseRefReservation(context, TENANT_ID, "31376")).toBeUndefined();
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(await readCaseRefReservation(context, "other-tenant", "31376")).toBeUndefined();
  });

  it("is separate from REF claims", async () => {
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(0);
  });

  it("still writes to the Dynamo table when the context is not postgres", async () => {
    const dynamoContext = buildTestContext();
    await reserveCaseRef(dynamoContext, TENANT_ID, "31376", "case_1");

    const stored = await dynamoContext.table.get(
      caseRefIndexPartitionKey(TENANT_ID, "31376"),
      META_SORT_KEY,
    );
    expect(stored).toMatchObject({ caseRef: "31376", caseId: "case_1" });
    expect(await scalar<number>("select count(*)::int as value from crm_case_ref_reservations")).toBe(0);
  });
});
