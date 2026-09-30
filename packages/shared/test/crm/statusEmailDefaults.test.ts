import { describe, expect, it } from "vitest";
import { CASE_STATUSES, defaultStatusEmailTemplate } from "../../src/crm";

describe("defaultStatusEmailTemplate", () => {
  it("provides a default subject and body for every case status", () => {
    for (const caseStatus of CASE_STATUSES) {
      const template = defaultStatusEmailTemplate(caseStatus);
      expect(template.subject.length).toBeGreaterThan(0);
      expect(template.body.length).toBeGreaterThan(0);
      expect(template.enabled).toBe(true);
    }
  });

  it("uses feedback placeholders in Application Received", () => {
    const template = defaultStatusEmailTemplate("NEW");
    expect(template.body).toContain("{{clientName}}");
    expect(template.body).toContain("{{applicationId}}");
    expect(template.body).toContain("{{phone}}");
  });

  it("includes applicantsBlock in Decision Received body", () => {
    const template = defaultStatusEmailTemplate("DECIDED");
    expect(template.body).toContain("{{applicantsBlock}}");
  });

  it("uses admin-aligned subject pattern for Application Received", () => {
    const template = defaultStatusEmailTemplate("NEW");
    expect(template.subject).toBe(
      "{{applicationId}} – Application Received – {{clientName}} – {{countryVisaType}}",
    );
  });

  it("keeps country/visa, date, time and centre of Appointment Booked on separate lines", () => {
    const bodyLines = defaultStatusEmailTemplate("APPOINTMENT_SET").body.split("\n");
    const countryVisaLines = bodyLines.filter((line) => line.includes("{{countryVisaType}}"));
    expect(countryVisaLines).toHaveLength(1);
    for (const optionalToken of ["{{appointmentDate}}", "{{appointmentTime}}", "{{centre}}"]) {
      const tokenLines = bodyLines.filter((line) => line.includes(optionalToken));
      expect(tokenLines).toHaveLength(1);
      expect(tokenLines[0]).not.toContain("{{countryVisaType}}");
      expect(tokenLines[0]!.match(/\{\{/g)).toHaveLength(1);
    }
  });
});
