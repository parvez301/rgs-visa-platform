import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readTrustLevel,
  readUserPrefs,
  recordConfirmedWithoutEdit,
  setUserPrefs,
} from "../../src/agent/prefs";
import { applyMigrations } from "../../src/db/migrate";
import { CRM_USER_PREFS_SORT_KEY, crmUserPrefsPartitionKey } from "../../src/domain/crm/keys";
import { readUserPrefsPostgres, writeUserPrefsPostgres } from "../../src/domain/crm/prefsPostgres";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const ALICE = "alice@rgs.local";
const BOB = "bob@rgs.local";

describe("CRM user prefs with CRM_STORE=postgres", () => {
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

  it("reads nothing for a user with no row, and the safe defaults through readUserPrefs", async () => {
    expect(await readUserPrefsPostgres(sql, TENANT_ID, ALICE)).toBeUndefined();
    expect(await readUserPrefs(context, TENANT_ID, ALICE)).toEqual({
      tenantId: TENANT_ID,
      email: ALICE,
      trustLevel: 0,
      autoApplyOptIn: false,
      defaultFilters: {},
      confirmedWithoutEditCount: 0,
    });
    expect(await readTrustLevel(context, TENANT_ID, ALICE)).toBe(0);
  });

  it("writes prefs and reads them back, upserting on (tenant_id, email)", async () => {
    await writeUserPrefsPostgres(sql, {
      tenantId: TENANT_ID,
      email: ALICE,
      trustLevel: 1,
      autoApplyOptIn: false,
      defaultFilters: { status: "OPEN" },
      confirmedWithoutEditCount: 3,
    });
    await writeUserPrefsPostgres(sql, {
      tenantId: TENANT_ID,
      email: ALICE,
      trustLevel: 2,
      autoApplyOptIn: true,
      defaultFilters: { status: "OPEN", partner: "p1" },
      confirmedWithoutEditCount: 4,
    });

    expect(await scalar<number>("select count(*)::int as value from crm_user_prefs")).toBe(1);
    expect(await readUserPrefsPostgres(sql, TENANT_ID, ALICE)).toEqual({
      tenantId: TENANT_ID,
      email: ALICE,
      trustLevel: 2,
      autoApplyOptIn: true,
      defaultFilters: { status: "OPEN", partner: "p1" },
      confirmedWithoutEditCount: 4,
    });
  });

  it("setUserPrefs stores in Postgres, merges onto the existing row, and leaves Dynamo empty", async () => {
    await setUserPrefs(context, TENANT_ID, ALICE, { trustLevel: 2, autoApplyOptIn: true });
    const merged = await setUserPrefs(context, TENANT_ID, ALICE, { trustLevel: 1 });

    expect(merged.trustLevel).toBe(1);
    expect(merged.autoApplyOptIn).toBe(true);
    expect(await readTrustLevel(context, TENANT_ID, ALICE)).toBe(1);
    expect(await scalar<number>("select count(*)::int as value from crm_user_prefs")).toBe(1);
    expect(
      await baseContext.table.get(crmUserPrefsPartitionKey(TENANT_ID, ALICE), CRM_USER_PREFS_SORT_KEY),
    ).toBeUndefined();
  });

  it("recordConfirmedWithoutEdit increments the count without touching trust or opt-in", async () => {
    await recordConfirmedWithoutEdit(context, TENANT_ID, ALICE);
    await recordConfirmedWithoutEdit(context, TENANT_ID, ALICE);

    const userPrefs = await readUserPrefs(context, TENANT_ID, ALICE);
    expect(userPrefs.confirmedWithoutEditCount).toBe(2);
    expect(userPrefs.trustLevel).toBe(0);
    expect(userPrefs.autoApplyOptIn).toBe(false);
    expect(
      await baseContext.table.get(crmUserPrefsPartitionKey(TENANT_ID, ALICE), CRM_USER_PREFS_SORT_KEY),
    ).toBeUndefined();
  });

  it("refuses an out-of-range trustLevel with a 400 and writes nothing", async () => {
    await expect(
      setUserPrefs(context, TENANT_ID, ALICE, { trustLevel: 5 as never }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await scalar<number>("select count(*)::int as value from crm_user_prefs")).toBe(0);
  });

  it("keeps users and tenants apart", async () => {
    await setUserPrefs(context, TENANT_ID, ALICE, { trustLevel: 2 });
    expect(await readTrustLevel(context, TENANT_ID, BOB)).toBe(0);
    expect(await readTrustLevel(context, "other", ALICE)).toBe(0);
  });
});
