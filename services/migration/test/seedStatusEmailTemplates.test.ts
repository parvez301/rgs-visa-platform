import { crm } from "@rgs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestContext, closeTestContexts } from "@rgs/api/test/helpers";
import { getStatusEmailTemplate, upsertStatusEmailTemplate } from "@rgs/api/src/domain/crm/statusEmailTemplates";
import { seedStatusEmailTemplates } from "../src/seedStatusEmailTemplates";

afterEach(closeTestContexts);

describe("seedStatusEmailTemplates", () => {
  it("inserts a default row for every status", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    const report = await seedStatusEmailTemplates(context, "rgs");
    expect(report.inserted).toBe(crm.CASE_STATUSES.length);
    for (const caseStatus of crm.CASE_STATUSES) {
      expect(await getStatusEmailTemplate(context, "rgs", caseStatus)).toBeDefined();
    }
  });

  it("is re-runnable and never overwrites a desk edit", async () => {
    const context = await buildTestContext({ seedStatusEmailTemplates: false });
    await seedStatusEmailTemplates(context, "rgs");
    const edited = { ...crm.defaultStatusEmailTemplate("SUBMITTED"), subject: "Edited by desk" };
    await upsertStatusEmailTemplate(context, "rgs", "SUBMITTED", edited, "desk@rgs.test");

    const secondReport = await seedStatusEmailTemplates(context, "rgs");
    expect(secondReport.inserted).toBe(0);
    expect((await getStatusEmailTemplate(context, "rgs", "SUBMITTED"))?.subject).toBe("Edited by desk");
  });
});
