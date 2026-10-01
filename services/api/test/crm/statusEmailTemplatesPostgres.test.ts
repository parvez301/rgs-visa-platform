import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { META_SORT_KEY, statusEmailTemplatePartitionKey } from "../../src/domain/crm/keys";
import {
  getStatusEmailTemplatePostgres,
  upsertStatusEmailTemplatePostgres,
} from "../../src/domain/crm/statusEmailTemplatesPostgres";
import {
  getStatusEmailTemplate,
  listStatusEmailTemplates,
  resetStatusEmailTemplate,
  seedStatusEmailTemplatesIfAbsent,
  UNSAVED_TEMPLATE_UPDATED_AT,
  upsertStatusEmailTemplate,
} from "../../src/domain/crm/statusEmailTemplates";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";
const STATUS = crm.CASE_STATUSES[0]!;
const OTHER_STATUS = crm.CASE_STATUSES[1]!;

describe("status email templates with CRM_STORE=postgres", () => {
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

  it("reads nothing when no row exists", async () => {
    expect(await getStatusEmailTemplatePostgres(sql, TENANT_ID, STATUS)).toBeUndefined();
    expect(await getStatusEmailTemplate(context, TENANT_ID, STATUS)).toBeUndefined();
  });

  it("upserts on (tenant_id, case_status) and reads back", async () => {
    const template: crm.StatusEmailTemplate = {
      tenantId: TENANT_ID,
      caseStatus: STATUS,
      subject: "First",
      body: "Body one",
      enabled: true,
      updatedAt: "2026-10-01T10:00:00.000Z",
      updatedBy: ACTOR,
    };
    await upsertStatusEmailTemplatePostgres(sql, template);
    await upsertStatusEmailTemplatePostgres(sql, {
      ...template,
      subject: "Second",
      enabled: false,
      updatedAt: "2026-10-01T11:00:00.000Z",
    });

    expect(await scalar<number>("select count(*)::int as value from crm_status_email_templates")).toBe(1);
    expect(await getStatusEmailTemplatePostgres(sql, TENANT_ID, STATUS)).toEqual({
      ...template,
      subject: "Second",
      enabled: false,
      updatedAt: "2026-10-01T11:00:00.000Z",
    });
    expect(await getStatusEmailTemplatePostgres(sql, "other", STATUS)).toBeUndefined();
  });

  it("upsertStatusEmailTemplate writes Postgres and leaves the Dynamo template PK empty", async () => {
    const saved = await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      STATUS,
      { subject: "Hi", body: "There", enabled: true },
      ACTOR,
    );

    expect(await getStatusEmailTemplate(context, TENANT_ID, STATUS)).toEqual(saved);
    expect(saved.updatedBy).toBe(ACTOR);
    expect(
      await baseContext.table.get(statusEmailTemplatePartitionKey(TENANT_ID, STATUS), META_SORT_KEY),
    ).toBeUndefined();
  });

  it("list fills defaults for statuses without a row", async () => {
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      STATUS,
      { subject: "Custom", body: "Custom body", enabled: false },
      ACTOR,
    );

    const templates = await listStatusEmailTemplates(context, TENANT_ID);
    expect(templates.map((template) => template.caseStatus)).toEqual([...crm.CASE_STATUSES]);
    expect(templates[0]).toMatchObject({ subject: "Custom", enabled: false, updatedBy: ACTOR });
    expect(templates[1]).toEqual({
      tenantId: TENANT_ID,
      caseStatus: OTHER_STATUS,
      ...crm.defaultStatusEmailTemplate(OTHER_STATUS),
      updatedAt: UNSAVED_TEMPLATE_UPDATED_AT,
      updatedBy: "",
    });
    expect(await scalar<number>("select count(*)::int as value from crm_status_email_templates")).toBe(1);
  });

  it("reset overwrites with the default and seed inserts only missing rows", async () => {
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      STATUS,
      { subject: "Edited", body: "Edited body", enabled: false },
      ACTOR,
    );
    const reset = await resetStatusEmailTemplate(context, TENANT_ID, OTHER_STATUS, ACTOR);
    expect(reset).toMatchObject({ ...crm.defaultStatusEmailTemplate(OTHER_STATUS), updatedBy: ACTOR });

    const inserted = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
    expect(inserted).toBe(crm.CASE_STATUSES.length - 2);
    expect((await getStatusEmailTemplate(context, TENANT_ID, STATUS))?.subject).toBe("Edited");
    expect(await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR)).toBe(0);
    expect(await scalar<number>("select count(*)::int as value from crm_status_email_templates")).toBe(
      crm.CASE_STATUSES.length,
    );
  });
});
