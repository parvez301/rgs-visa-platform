import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { META_SORT_KEY, statusEmailTemplatePartitionKey } from "../../src/domain/crm/keys";
import {
  getStatusEmailTemplate,
  listStatusEmailTemplates,
  resetStatusEmailTemplate,
  seedStatusEmailTemplatesIfAbsent,
  upsertStatusEmailTemplate,
} from "../../src/domain/crm/statusEmailTemplates";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";
const EPOCH = "1970-01-01T00:00:00.000Z";

describe("statusEmailTemplatePartitionKey", () => {
  it("is tenant- and status-scoped", () => {
    expect(statusEmailTemplatePartitionKey("rgs", "VISA_GRANTED")).toBe(
      "TENANT#rgs#STATUS_EMAIL_TEMPLATE#VISA_GRANTED",
    );
  });
});

describe("getStatusEmailTemplate", () => {
  it("returns undefined when nothing is stored", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toBeUndefined();
  });
});

describe("upsertStatusEmailTemplate", () => {
  it("stores the template stamped with actor and time, and reads it back", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
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
    const raw = await context.table.get(statusEmailTemplatePartitionKey(TENANT_ID, "NEW"), META_SORT_KEY);
    expect(raw).toBeDefined();
  });

  it("overwrites an earlier template", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
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
  });

  it("rejects an empty body with a 400", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    await expect(
      upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "a", body: "   ", enabled: true }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listStatusEmailTemplates", () => {
  it("returns one valid entry per case status, defaults with epoch updatedAt and empty updatedBy", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
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
    const context = buildTestContext({ seedStatusEmailTemplates: false });
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
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    await listStatusEmailTemplates(context, TENANT_ID);
    expect(await getStatusEmailTemplate(context, TENANT_ID, "NEW")).toBeUndefined();
  });
});

describe("resetStatusEmailTemplate", () => {
  it("overwrites a customised template with the default, stamped with actor and time", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
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
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    const first = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
    const second = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
    expect(first).toBe(crm.CASE_STATUSES.length);
    expect(second).toBe(0);
    const seeded = await getStatusEmailTemplate(context, TENANT_ID, "NEW");
    expect(seeded).toMatchObject({ ...crm.defaultStatusEmailTemplate("NEW"), updatedBy: ACTOR });
  });

  it("does not overwrite a desk edit", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    await upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "mine", body: "mine", enabled: true }, ACTOR);
    const inserted = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, "seed@rgs.local");
    expect(inserted).toBe(crm.CASE_STATUSES.length - 1);
    expect((await getStatusEmailTemplate(context, TENANT_ID, "NEW"))?.subject).toBe("mine");
  });
});
