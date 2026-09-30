import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { getStatusEmailTemplate, upsertStatusEmailTemplate } from "@rgs/api/src/domain/crm/statusEmailTemplates";
import type { AppContext } from "@rgs/api/src/lib/context";
import { seedStatusEmailTemplates } from "../src/seedStatusEmailTemplates";

function buildContext(): AppContext {
  return {
    table: new InMemoryTableClient(),
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  };
}

describe("seedStatusEmailTemplates", () => {
  it("inserts a default row for every status", async () => {
    const context = buildContext();
    const report = await seedStatusEmailTemplates(context, "rgs");
    expect(report.inserted).toBe(crm.CASE_STATUSES.length);
    for (const caseStatus of crm.CASE_STATUSES) {
      expect(await getStatusEmailTemplate(context, "rgs", caseStatus)).toBeDefined();
    }
  });

  it("is re-runnable and never overwrites a desk edit", async () => {
    const context = buildContext();
    await seedStatusEmailTemplates(context, "rgs");
    const edited = { ...crm.defaultStatusEmailTemplate("SUBMITTED"), subject: "Edited by desk" };
    await upsertStatusEmailTemplate(context, "rgs", "SUBMITTED", edited, "desk@rgs.test");

    const secondReport = await seedStatusEmailTemplates(context, "rgs");
    expect(secondReport.inserted).toBe(0);
    expect((await getStatusEmailTemplate(context, "rgs", "SUBMITTED"))?.subject).toBe("Edited by desk");
  });
});
