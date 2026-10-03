import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../../src/lib/sql";
import {
  assertApplicantRefNosDistinct,
  claimNewRefs,
  normalizeRefKey,
  readRefClaim,
  refKeysOfCase,
  releaseRefKeys,
  staleRefKeys,
} from "../../src/domain/crm/refClaims";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";

afterEach(closeSqlTestContexts);

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
    const context = await buildSqlTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("rgs-100"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("RGS-100 ")),
    ).rejects.toMatchObject({ statusCode: 409, message: 'REF "RGS-100 " is already used by another case.' });
    expect((await readRefClaim(context, TENANT_ID, "RGS-100"))?.caseId).toBe("case_A");
  });

  it("releases what it claimed in the same call when a later key clashes", async () => {
    const context = await buildSqlTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("TAKEN"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("FRESH", ["TAKEN"])),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readRefClaim(context, TENANT_ID, "FRESH")).toBeUndefined();
  });

  it("treats a claim that already names this case as its own, and still reports it for rollback", async () => {
    // A putIfAbsent that landed but whose response was lost: the retry sees our
    // own claim. It must come back in the list, or a later writeCase failure
    // would never release it and the REF would be orphaned forever.
    const context = await buildSqlTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"));
    await expect(claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"))).resolves.toEqual(["R-1"]);
  });

  it("does not report keys the previous version already held", async () => {
    const context = await buildSqlTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("HELD"));
    await expect(
      claimNewRefs(context, TENANT_ID, "case_A", caseShape("HELD"), caseShape("HELD", ["NEW-2"])),
    ).resolves.toEqual(["NEW-2"]);
  });

  it("claims only keys the previous version did not have", async () => {
    const context = await buildSqlTestContext();
    const newlyClaimed = await claimNewRefs(context, TENANT_ID, "case_A", caseShape("OLD"), caseShape("OLD", ["NEW-1"]));
    expect(newlyClaimed).toEqual(["NEW-1"]);
    expect(await readRefClaim(context, TENANT_ID, "OLD")).toBeUndefined();
  });

  it("retries the claim when the holder released it between our put and our read", async () => {
    const context = await buildSqlTestContext();
    await claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("RACE-1"));

    // The holder lets go after our insert lost but before our read lands: the
    // first read of the claim returns nothing, as it would if the delete had
    // committed in between.
    const realSql = context.sql;
    let intercepted = false;
    const racingContext: SqlTestContext = {
      ...context,
      sql: {
        ...realSql,
        transaction: realSql.transaction.bind(realSql),
        end: realSql.end.bind(realSql),
        query: async (text, values) => {
          if (!intercepted && /^\s*select/i.test(text) && text.includes("crm_ref_claims")) {
            intercepted = true;
            await realSql.query(`delete from crm_ref_claims where case_id = 'case_B'`);
            return { rows: [], rowCount: 0 };
          }
          return realSql.query(text, values);
        },
      },
    };

    await expect(claimNewRefs(racingContext, TENANT_ID, "case_A", undefined, caseShape("RACE-1"))).resolves.toEqual([
      "RACE-1",
    ]);
    expect((await readRefClaim(context, TENANT_ID, "RACE-1"))?.caseId).toBe("case_A");
  });

  it("release deletes only claims that name this case", async () => {
    const context = await buildSqlTestContext();
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

describe("REF claims on Postgres (SQL row assertions)", () => {
  let context: SqlTestContext;
  let sql: SqlClient;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  beforeEach(async () => {
    context = await buildSqlTestContext({ seedStatusEmailTemplates: false });
    sql = context.sql;
  });

  it("claims the case REF and every applicant REF NO in crm_ref_claims", async () => {
    const claimed = await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("38017", ["p-2"]));

    expect(claimed).toEqual(["38017", "P-2"]);
    expect(await readRefClaim(context, TENANT_ID, "P-2")).toMatchObject({
      tenantId: TENANT_ID,
      refKey: "P-2",
      refValue: "p-2",
      caseId: "case_1",
      claimedAt: "2026-07-23T10:00:00.000Z",
    });
    expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(2);
  });

  it("answers 409 when another case holds the REF, whatever the case or spacing", async () => {
    await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("RGS  100"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("rgs 100")),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await readRefClaim(context, TENANT_ID, "RGS 100"))?.caseId).toBe("case_1");
  });

  it("rolls back the keys it had already claimed when a later key is taken", async () => {
    await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("TAKEN"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("FRESH", ["TAKEN"])),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await readRefClaim(context, TENANT_ID, "FRESH")).toBeUndefined();
    expect((await readRefClaim(context, TENANT_ID, "TAKEN"))?.caseId).toBe("case_1");
  });

  it("does not 409 a case on its own REF, and only claims what the new version adds", async () => {
    const first = caseShape("38017");
    await claimNewRefs(context, TENANT_ID, "case_1", undefined, first);

    const again = await claimNewRefs(context, TENANT_ID, "case_1", first, caseShape("38017", ["38017", "P-3"]));
    expect(again).toEqual(["P-3"]);
    // A retry whose first attempt landed but lost its response: our own claim is not a conflict.
    expect(await claimNewRefs(context, TENANT_ID, "case_1", undefined, first)).toEqual(["38017"]);
  });

  it("lets exactly one of two concurrent claimants win the REF", async () => {
    const outcomes = await Promise.allSettled([
      claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("RACE-1")),
      claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("RACE-1")),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
    expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(1);
  });

  it("releases only the claims the case owns, after which the REF is free", async () => {
    await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("MINE"));

    await releaseRefKeys(context, TENANT_ID, "case_2", ["MINE"]);
    expect((await readRefClaim(context, TENANT_ID, "MINE"))?.caseId).toBe("case_1");

    await releaseRefKeys(context, TENANT_ID, "case_1", ["MINE", "NEVER-CLAIMED"]);
    expect(await readRefClaim(context, TENANT_ID, "MINE")).toBeUndefined();

    expect(await claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("MINE"))).toEqual(["MINE"]);
  });

  it("scopes claims to the tenant", async () => {
    await claimNewRefs(context, "tenant_a", "case_1", undefined, caseShape("SHARED"));
    expect(await claimNewRefs(context, "tenant_b", "case_2", undefined, caseShape("SHARED"))).toEqual(["SHARED"]);
  });
});
