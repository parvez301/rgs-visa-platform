import { crm } from "@rgs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";
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

afterEach(closeTestContexts);

async function templateRowCount(context: TestContext): Promise<number> {
  const result = await context.sql.query<{ value: number }>(
    "select count(*)::int as value from crm_status_email_templates",
  );
  return result.rows[0]!.value;
}

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";
const EPOCH = "1970-01-01T00:00:00.000Z";

describe("getStatusEmailTemplate", () => {
  it("returns undefined when nothing is stored", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toBeUndefined();
  });
});

describe("upsertStatusEmailTemplate", () => {
  it("stores the template stamped with actor and time, and reads it back", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const written = await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "NEW",
      { subject: "Hi {{clientName}}", body: "Body {{applicationId}}", enabled: false },
      ACTOR,
    );
    expect(written).toEqual({
      tenantId: TENANT_ID,
      caseStatus: "NEW",
      subject: "Hi {{clientName}}",
      body: "Body {{applicationId}}",
      enabled: false,
      updatedAt: context.now().toISOString(),
      updatedBy: ACTOR,
    });
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toEqual(written);
    expect(await templateRowCount(context)).toBe(1);
  });

  it("overwrites an earlier template", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "a", body: "b", enabled: true }, ACTOR);
    context.advanceClock(1000);
    const second = await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "NEW",
      { subject: "c", body: "d", enabled: true },
      "other@rgs.local",
    );
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toEqual(second);
    expect(second.subject).toBe("c");
    expect(second.updatedBy).toBe("other@rgs.local");
    // An upsert on (tenant, status): the second write replaces the first row.
    expect(await templateRowCount(context)).toBe(1);
  });

  it("rejects an empty body with a 400", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await expect(
      upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "a", body: "   ", enabled: true }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listStatusEmailTemplates", () => {
  it("returns one valid entry per case status, defaults with epoch updatedAt and empty updatedBy", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const listed = await listStatusEmailTemplates(context, TENANT_ID);
    expect(listed.map((template) => template.caseStatus)).toEqual([...crm.CASE_STATUSES]);
    for (const template of listed) {
      expect(() => crm.StatusEmailTemplateSchema.parse(template)).not.toThrow();
      expect(template.updatedAt).toBe(EPOCH);
      expect(template.updatedBy).toBe("");
      expect(template).toMatchObject(crm.defaultStatusEmailTemplate(template.caseStatus));
    }
  });

  it("returns the stored row in place of the default", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const stored = await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "VISA_GRANTED",
      { subject: "Custom", body: "Custom body", enabled: false },
      ACTOR,
    );
    const listed = await listStatusEmailTemplates(context, TENANT_ID);
    expect(listed).toHaveLength(crm.CASE_STATUSES.length);
    expect(listed.find((template) => template.caseStatus === "VISA_GRANTED")).toEqual(stored);
    expect(listed.find((template) => template.caseStatus === "NEW")?.updatedBy).toBe("");
  });

  it("does not persist defaults", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await listStatusEmailTemplates(context, TENANT_ID);
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toBeUndefined();
    expect(await templateRowCount(context)).toBe(0);
  });

  it("fills defaults for statuses without a row and keeps one stored row", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const [status, otherStatus] = crm.CASE_STATUSES;
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      status!,
      { subject: "Custom", body: "Custom body", enabled: false },
      ACTOR,
    );

    const listed = await listStatusEmailTemplates(context, TENANT_ID);
    expect(listed.map((template) => template.caseStatus)).toEqual([...crm.CASE_STATUSES]);
    expect(listed[0]).toMatchObject({ subject: "Custom", enabled: false, updatedBy: ACTOR });
    expect(listed[1]).toEqual({
      tenantId: TENANT_ID,
      caseStatus: otherStatus,
      ...crm.defaultStatusEmailTemplate(otherStatus!),
      updatedAt: UNSAVED_TEMPLATE_UPDATED_AT,
      updatedBy: "",
    });
    expect(await templateRowCount(context)).toBe(1);
  });
});

describe("resetStatusEmailTemplate", () => {
  it("overwrites a customised template with the default, stamped with actor and time", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "x", body: "y", enabled: false }, ACTOR);
    context.advanceClock(5000);
    const reset = await resetStatusEmailTemplate(context, TENANT_ID, "NEW", "boss@rgs.local");
    expect(reset).toEqual({
      tenantId: TENANT_ID,
      caseStatus: "NEW",
      ...crm.defaultStatusEmailTemplate("NEW"),
      updatedAt: context.now().toISOString(),
      updatedBy: "boss@rgs.local",
    });
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toEqual(reset);
  });
});

describe("seedStatusEmailTemplatesIfAbsent", () => {
  it("seed inserts defaults once; second seed inserts zero", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const first = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
    const second = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
    expect(first).toBe(crm.CASE_STATUSES.length);
    expect(second).toBe(0);
    const seeded = await getStatusEmailTemplate(context, TENANT_ID, "NEW");
    expect(seeded).toMatchObject({ ...crm.defaultStatusEmailTemplate("NEW"), updatedBy: ACTOR });
  });

  it("does not overwrite a desk edit", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "mine", body: "mine", enabled: true }, ACTOR);
    const inserted = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, "seed@rgs.local");
    expect(inserted).toBe(crm.CASE_STATUSES.length - 1);
    expect((await getStatusEmailTemplate(context, TENANT_ID, "NEW"))?.subject).toBe("mine");
    expect(await templateRowCount(context)).toBe(crm.CASE_STATUSES.length);
  });

  it("seeds only the missing rows after a reset, and a re-seed inserts none", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const [status, otherStatus] = crm.CASE_STATUSES;
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      status!,
      { subject: "Edited", body: "Edited body", enabled: false },
      ACTOR,
    );
    const reset = await resetStatusEmailTemplate(context, TENANT_ID, otherStatus!, ACTOR);
    expect(reset).toMatchObject({ ...crm.defaultStatusEmailTemplate(otherStatus!), updatedBy: ACTOR });

    expect(await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR)).toBe(
      crm.CASE_STATUSES.length - 2,
    );
    expect((await getStatusEmailTemplate(context, TENANT_ID, status!))?.subject).toBe("Edited");
    expect(await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR)).toBe(0);
    expect(await templateRowCount(context)).toBe(crm.CASE_STATUSES.length);
  });
});

describe("the Postgres template store", () => {
  it("upserts on (tenant_id, case_status), reads back, and keeps tenants apart", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const status = crm.CASE_STATUSES[0]!;
    expect(await getStatusEmailTemplatePostgres(context.sql, TENANT_ID, status)).toBeUndefined();

    const template: crm.StatusEmailTemplate = {
      tenantId: TENANT_ID,
      caseStatus: status,
      subject: "First",
      body: "Body one",
      enabled: true,
      updatedAt: "2026-10-01T10:00:00.000Z",
      updatedBy: ACTOR,
    };
    await upsertStatusEmailTemplatePostgres(context.sql, template);
    await upsertStatusEmailTemplatePostgres(context.sql, {
      ...template,
      subject: "Second",
      enabled: false,
      updatedAt: "2026-10-01T11:00:00.000Z",
    });

    expect(await templateRowCount(context)).toBe(1);
    expect(await getStatusEmailTemplatePostgres(context.sql, TENANT_ID, status)).toEqual({
      ...template,
      subject: "Second",
      enabled: false,
      updatedAt: "2026-10-01T11:00:00.000Z",
    });
    expect(await getStatusEmailTemplatePostgres(context.sql, "other", status)).toBeUndefined();
  });
});
