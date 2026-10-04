import { afterEach, describe, expect, it } from "vitest";
import { buildTestContext, closeTestContexts } from "../helpers";
import { resolveCaseTravellers } from "../../src/domain/crm/caseTravellers";
import { upsertTraveller } from "../../src/domain/crm/travellers";

afterEach(closeTestContexts);

describe("resolveCaseTravellers", () => {
  it("maps each applicant's travellerId to the traveller's name and passport", async () => {
    const context = await buildTestContext();
    const asha = await upsertTraveller(context, "rgs", { fullName: "Asha Rao", passportNumber: "Z1" });
    const ravi = await upsertTraveller(context, "rgs", { fullName: "Ravi Rao" });

    const travellers = await resolveCaseTravellers(context, "rgs", [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: ravi.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(travellers).toEqual({
      [asha.travellerId]: { fullName: "Asha Rao", passportNumber: "Z1" },
      [ravi.travellerId]: { fullName: "Ravi Rao" },
    });
  });

  it("leaves out a traveller that is missing or corrupt rather than failing the read", async () => {
    const context = await buildTestContext();
    const asha = await upsertTraveller(context, "rgs", { fullName: "Asha Rao" });
    await context.sql.query(
      `insert into crm_travellers (tenant_id, traveller_id, full_name, normalized_name, created_at)
       values ('rgs', 'trv_corrupt', '   ', 'blank', '2026-07-23T10:00:00.000Z')`,
    );

    const travellers = await resolveCaseTravellers(context, "rgs", [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "trv_missing", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A3", travellerId: "trv_corrupt", custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(Object.keys(travellers)).toEqual([asha.travellerId]);
  });
});
