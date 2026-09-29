import { describe, expect, it } from "vitest";
import { buildCaseExportRows } from "../../src/domain/crm/caseExport";
import { createCase } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { buildTestContext } from "../helpers";

describe("buildCaseExportRows", () => {
  it("returns one row per applicant in the order asked, with partner and traveller names, and lists missing ids", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, "rgs", { canonicalName: "Export Tours", partnerType: "AGENCY" }, "desk@rgs.local");
    const firstTraveller = await upsertTraveller(context, "rgs", { fullName: "MEERA IYER", passportNumber: "M1234567" });
    const secondTraveller = await upsertTraveller(context, "rgs", { fullName: "RAJ IYER" });
    const familyCase = await createCase(
      context,
      "rgs",
      {
        caseRef: "EXP-1",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        remarks: "priority",
        groupName: "Iyer Family",
        clientEmail: "meera@example.com",
        applicants: [
          { applicantRef: "A1", travellerId: firstTraveller.travellerId, passportNumber: "M1234567", refNo: "EXP-1-A" },
          { applicantRef: "A2", travellerId: secondTraveller.travellerId },
        ],
      },
      "desk@rgs.local",
    );

    const exportResult = await buildCaseExportRows(context, "rgs", [familyCase.caseId, "case_missing"]);

    expect(exportResult.missingCaseIds).toEqual(["case_missing"]);
    expect(exportResult.rows).toHaveLength(2);
    expect(exportResult.rows[0]).toMatchObject({
      caseRef: "EXP-1",
      groupName: "Iyer Family",
      partnerName: "Export Tours",
      destinationCountry: "JP",
      caseStatus: "NEW",
      remarks: "priority",
      clientEmail: "meera@example.com",
      applicantRefNo: "EXP-1-A",
      applicantName: "MEERA IYER",
      passportNumber: "M1234567",
      custody: "NOT_HELD",
      outcome: "PENDING",
    });
    expect(exportResult.rows[1]).toMatchObject({ applicantRefNo: "A2", applicantName: "RAJ IYER" });
  });
});
