import { describe, expect, it } from "vitest";
import { renderStatusEmail, type StatusEmailVars } from "../../src/domain/crm/statusEmailRender";

const VARS: StatusEmailVars = {
  clientName: "Asha",
  countryVisaType: "UAE Tourist",
  applicationId: "31377",
  appointmentDate: "",
  appointmentTime: "",
  centre: "",
  applicantsBlock: "",
  phone: "+91 …",
};

describe("renderStatusEmail", () => {
  it("drops a line that becomes blank after substitution", () => {
    const rendered = renderStatusEmail(
      "Hello {{clientName}}\nAppointment: {{appointmentDate}} at {{appointmentTime}} at {{centre}}\nBye",
      VARS,
    );
    expect(rendered).toBe("Hello Asha\nBye");
    expect(rendered).not.toContain("{{");
  });

  it("drops a line made only of a token that resolved empty or whitespace", () => {
    const rendered = renderStatusEmail("Hello {{clientName}}\n{{applicantsBlock}}\n  {{centre}}  \nBye", VARS);
    expect(rendered).toBe("Hello Asha\nBye");
  });

  it("keeps a line whose tokens partly resolved", () => {
    const rendered = renderStatusEmail("On {{appointmentDate}} at {{centre}}", { ...VARS, appointmentDate: "05 Oct 2026" });
    expect(rendered).toBe("On 05 Oct 2026 at ");
  });

  it("keeps authored blank lines between paragraphs", () => {
    const rendered = renderStatusEmail("Dear {{clientName}},\n\nID: {{applicationId}}\n\nRegards", VARS);
    expect(rendered).toBe("Dear Asha,\n\nID: 31377\n\nRegards");
  });

  it("does not leave a double blank line behind when a dropped line sat between two blanks", () => {
    const rendered = renderStatusEmail("Dear {{clientName}},\n\n{{applicantsBlock}}\n\nRegards", VARS);
    expect(rendered).toBe("Dear Asha,\n\nRegards");
  });

  it("replaces every occurrence of a token", () => {
    expect(renderStatusEmail("{{applicationId}} / {{applicationId}}", VARS)).toBe("31377 / 31377");
  });

  it("leaves no known token behind", () => {
    const rendered = renderStatusEmail(
      "{{clientName}}|{{countryVisaType}}|{{applicationId}}|{{appointmentDate}}|{{appointmentTime}}|{{centre}}|{{applicantsBlock}}|{{phone}}",
      VARS,
    );
    expect(rendered).toBe("Asha|UAE Tourist|31377|||||+91 …");
  });

  it("replaces an unknown token with nothing rather than leaving {{…}} on the wire", () => {
    expect(renderStatusEmail("Hi {{clientName}}{{nope}}", VARS)).toBe("Hi Asha");
  });

  it("does not re-expand token-looking text inside a substituted value", () => {
    expect(renderStatusEmail("Hi {{clientName}}", { ...VARS, clientName: "{{phone}}" })).toBe("Hi {{phone}}");
  });

  it("keeps a multi-line applicants block intact", () => {
    const rendered = renderStatusEmail("Applicants:\n{{applicantsBlock}}\nBye", {
      ...VARS,
      applicantsBlock: "1. Asha\n2. Ravi",
    });
    expect(rendered).toBe("Applicants:\n1. Asha\n2. Ravi\nBye");
  });
});
