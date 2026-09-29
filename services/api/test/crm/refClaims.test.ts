import { describe, expect, it, vi } from "vitest";
import {
  assertApplicantRefNosDistinct,
  claimNewRefs,
  normalizeRefKey,
  readRefClaim,
  refKeysOfCase,
  releaseRefKeys,
  staleRefKeys,
} from "../../src/domain/crm/refClaims";
import { refClaimPartitionKey } from "../../src/domain/crm/keys";
import { buildTestContext } from "../helpers";

const TENANT_ID = "rgs";

function caseShape(caseRef: string, refNos: (string | undefined)[] = []) {
  return {
    caseRef,
    applicants: refNos.map((refNo, applicantIndex) => ({
      applicantRef: `A${applicantIndex + 1}`,
      travellerId: `trv_${applicantIndex}`,
      custody: "NOT_HELD" as const,
      outcome: "PENDING" as const,
      ...(refNo === undefined ? {} : { refNo }),
    })),
  };
}

describe("normalizeRefKey", () => {
  it("trims, collapses inner whitespace and uppercases", () => {
    expect(normalizeRefKey("  rgs-100 ")).toBe("RGS-100");
    expect(normalizeRefKey("RGS  100")).toBe("RGS 100");
  });
});

describe("refKeysOfCase", () => {
  it("collects the case REF and every applicant REF NO, one entry per normalized key", () => {
    const refKeys = refKeysOfCase(caseShape("38017", ["38017", "p-2", undefined]));
    expect([...refKeys.keys()]).toEqual(["38017", "P-2"]);
    expect(refKeys.get("P-2")).toBe("p-2");
  });
});

describe("assertApplicantRefNosDistinct", () => {
  it("refuses two applicants in one case with the same REF NO, ignoring case", () => {
    expect(() => assertApplicantRefNosDistinct(caseShape("1", ["ab-1", "AB-1 "]))).toThrow(/used twice/);
  });
  it("allows an applicant REF NO equal to its own case REF", () => {
    expect(() => assertApplicantRefNosDistinct(caseShape("38017", ["38017"]))).not.toThrow();
  });
});

describe("claimNewRefs / releaseRefKeys", () => {
  it("claims every new key and refuses a key another case holds, case-insensitively", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("rgs-100"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("RGS-100 ")),
    ).rejects.toMatchObject({ statusCode: 409, message: 'REF "RGS-100 " is already used by another case.' });
    expect((await readRefClaim(context, TENANT_ID, "RGS-100"))?.caseId).toBe("case_A");
  });

  it("releases what it claimed in the same call when a later key clashes", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("TAKEN"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("FRESH", ["TAKEN"])),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readRefClaim(context, TENANT_ID, "FRESH")).toBeUndefined();
  });

  it("treats a claim that already names this case as its own (idempotent retry)", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"));
    await expect(claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"))).resolves.toEqual([]);
  });

  it("claims only keys the previous version did not have", async () => {
    const context = buildTestContext();
    const newlyClaimed = await claimNewRefs(context, TENANT_ID, "case_A", caseShape("OLD"), caseShape("OLD", ["NEW-1"]));
    expect(newlyClaimed).toEqual(["NEW-1"]);
    expect(await readRefClaim(context, TENANT_ID, "OLD")).toBeUndefined();
  });

  it("retries the claim when the holder released it between our put and our read", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("RACE-1"));

    // The holder lets go after our putIfAbsent lost but before our read lands.
    const realGet = context.table.get.bind(context.table);
    const getSpy = vi.spyOn(context.table, "get").mockImplementationOnce(async () => {
      await context.table.delete(refClaimPartitionKey(TENANT_ID, "RACE-1"), "META");
      return undefined;
    });
    getSpy.mockImplementation(realGet);

    await expect(claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("RACE-1"))).resolves.toEqual([
      "RACE-1",
    ]);
    expect((await readRefClaim(context, TENANT_ID, "RACE-1"))?.caseId).toBe("case_A");
  });

  it("release deletes only claims that name this case", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("MINE"));
    await claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("THEIRS"));

    await releaseRefKeys(context, TENANT_ID, "case_A", ["MINE", "THEIRS"]);
    expect(await readRefClaim(context, TENANT_ID, "MINE")).toBeUndefined();
    expect((await readRefClaim(context, TENANT_ID, "THEIRS"))?.caseId).toBe("case_B");
  });

  it("staleRefKeys lists keys dropped between versions", () => {
    expect(staleRefKeys(caseShape("A", ["X"]), caseShape("B", ["x"]))).toEqual(["A"]);
  });
});
