import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { resolveCaseTravellers } from "../../src/domain/crm/caseTravellers";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { META_SORT_KEY, travellerPartitionKey } from "../../src/domain/crm/keys";

describe("resolveCaseTravellers", () => {
  it("maps each applicant's travellerId to the traveller's name and passport", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    const asha = await upsertTraveller(context, "rgs", { fullName: "Asha Rao" });
    await context.table.put({ PK: travellerPartitionKey("rgs", "trv_corrupt"), SK: META_SORT_KEY, fullName: 42 });

    const travellers = await resolveCaseTravellers(context, "rgs", [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "trv_missing", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A3", travellerId: "trv_corrupt", custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(Object.keys(travellers)).toEqual([asha.travellerId]);
  });
});
