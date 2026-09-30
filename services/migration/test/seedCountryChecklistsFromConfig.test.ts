import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { InMemoryDocumentStore } from "@rgs/api/src/lib/documentStore";
import { InMemoryEmailSender } from "@rgs/api/src/lib/email";
import type { AppContext } from "@rgs/api/src/lib/context";
import { findCountryChecklist, putCountryChecklist } from "@rgs/api/src/domain/crm/countryChecklist";
import { seedCountryChecklistsFromConfig } from "../src/seedCountryChecklistsFromConfig";

const TENANT_ID = "rgs";

function buildContext(): AppContext {
  return {
    table: new InMemoryTableClient(),
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  };
}

describe("seedCountryChecklistsFromConfig", () => {
  it("inserts labeled documents from the seed catalog and is idempotent", async () => {
    const context = buildContext();
    const first = await seedCountryChecklistsFromConfig(context, TENANT_ID);
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.skippedExisting).toBe(0);

    const uae = await findCountryChecklist(context, TENANT_ID, "AE");
    expect(uae?.requiredDocuments).toEqual(
      expect.arrayContaining(["Passport bio page", "Passport-size photo"]),
    );

    const second = await seedCountryChecklistsFromConfig(context, TENANT_ID);
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBe(first.inserted);
  });

  it("does not overwrite an existing CRM checklist", async () => {
    const context = buildContext();
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Desk custom passport"] },
      "desk@rgs.test",
    );
    const report = await seedCountryChecklistsFromConfig(context, TENANT_ID);
    expect(report.skippedExisting).toBeGreaterThan(0);
    const uae = await findCountryChecklist(context, TENANT_ID, "AE");
    expect(uae?.requiredDocuments).toEqual(["Desk custom passport"]);
  });
});
