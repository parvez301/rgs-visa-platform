import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildStatusEmailVars } from "../../src/domain/crm/statusNotify";

const TRAVELLER_ID = "trv_1";

const CRM_CASE: crm.CrmCase = crm.CrmCaseSchema.parse({
  caseId: "case_1",
  tenantId: "rgs",
  caseRef: "38017",
  caseType: "VISA",
  partnerId: "ptn_1",
  destinationCountry: "JP",
  visaType: "TOURIST",
  caseStatus: "APPOINTMENT_SET",
  billingStatus: "UNBILLED",
  receivedDate: "2026-09-01",
  appointmentDate: "2026-10-12",
  applicants: [
    {
      travellerId: TRAVELLER_ID,
      applicantRef: "38017-A",
      custody: "NOT_HELD",
      outcome: "PENDING",
    },
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const TRAVELLERS: crm.CaseTravellerMap = { [TRAVELLER_ID]: { fullName: "Anil Sharma" } };

/**
 * The admin template editor lists placeholders from the shared var names and
 * marks `STATUS_EMAIL_UNPOPULATED_VARS` as omitted from mail. Neither claim is
 * checkable from the admin app, which cannot import this service — so pin both
 * against the server's actual builder here.
 */
describe("status email vars match what the admin editor advertises", () => {
  const vars = buildStatusEmailVars(CRM_CASE, TRAVELLERS);

  it("fills exactly the shared var names, no more and no fewer", () => {
    expect(Object.keys(vars).sort()).toEqual([...crm.STATUS_EMAIL_VAR_NAMES].sort());
  });

  it("leaves every var the editor marks as not captured blank", () => {
    for (const varName of crm.STATUS_EMAIL_UNPOPULATED_VARS) {
      expect(vars[varName]).toBe("");
    }
  });

  it("fills the vars the editor does not mark, given a case that carries them", () => {
    for (const varName of crm.STATUS_EMAIL_VAR_NAMES) {
      if (crm.STATUS_EMAIL_UNPOPULATED_VARS.includes(varName)) continue;
      if (varName === "applicantsBlock") continue; // Empty by design for an individual case.
      expect(vars[varName]).not.toBe("");
    }
  });

  it("drops the shipped Appointment Booked lines whose only tokens are blank", () => {
    const rendered = crm.renderStatusEmail(
      crm.defaultStatusEmailTemplate("APPOINTMENT_SET").body,
      vars,
    );
    expect(rendered).toContain("Appointment date: 12 Oct 2026");
    expect(rendered).not.toContain("Appointment time:");
    expect(rendered).not.toContain("Centre:");
  });
});
