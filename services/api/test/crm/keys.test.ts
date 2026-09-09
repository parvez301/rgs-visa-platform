import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APPLICANT_SORT_KEY_PREFIX,
  META_SORT_KEY,
  DEFAULT_TENANT_ID,
  applicantSortKey,
  caseIdFromPartitionKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  eventSortKey,
  partnerCasesGsi2Pk,
  partnerPartitionKey,
  passportGsi3Pk,
  travellerPartitionKey,
} from "../../src/domain/crm/keys";

describe("crm keys", () => {
  it("puts a tenant segment on every partition key", () => {
    expect(casePartitionKey("rgs", "case_1")).toBe("TENANT#rgs#CASE#case_1");
    expect(partnerPartitionKey("rgs", "p_1")).toBe("TENANT#rgs#PARTNER#p_1");
    expect(travellerPartitionKey("rgs", "t_1")).toBe("TENANT#rgs#TRAVELLER#t_1");
  });

  it("recovers the caseId a case partition key was built from", () => {
    expect(caseIdFromPartitionKey(casePartitionKey("rgs", "case_1"))).toBe("case_1");
    // Not a case partition, and a case partition naming no case: neither yields an id.
    expect(caseIdFromPartitionKey(partnerPartitionKey("rgs", "p_1"))).toBeUndefined();
    expect(caseIdFromPartitionKey("TENANT#rgs#CASE#")).toBeUndefined();
  });

  it("keeps tenants apart", () => {
    expect(casePartitionKey("rgs", "case_1")).not.toBe(casePartitionKey("other", "case_1"));
  });

  it("zero-pads applicant sort keys so they sort in order", () => {
    expect(applicantSortKey(0)).toBe("APPLICANT#00");
    expect(applicantSortKey(9)).toBe("APPLICANT#09");
    expect(applicantSortKey(12)).toBe("APPLICANT#12");
    // Lexicographic order must match numeric order — this is why padding exists.
    const sorted = [applicantSortKey(10), applicantSortKey(2)].sort();
    expect(sorted).toEqual([applicantSortKey(2), applicantSortKey(10)]);
  });

  it("prefixes applicant keys so a case query can select just them", () => {
    expect(applicantSortKey(3).startsWith(APPLICANT_SORT_KEY_PREFIX)).toBe(true);
    expect(META_SORT_KEY.startsWith(APPLICANT_SORT_KEY_PREFIX)).toBe(false);
  });

  it("builds the three index keys from spec section 5", () => {
    expect(caseStatusGsi1Pk("rgs", "SUBMITTED")).toBe("TENANT#rgs#CASE_STATUS#SUBMITTED");
    expect(partnerCasesGsi2Pk("rgs", "p_1")).toBe("TENANT#rgs#PARTNER#p_1");
    expect(passportGsi3Pk("rgs", "Z6931368")).toBe("TENANT#rgs#PASSPORT#Z6931368");
  });

  it("sorts events by time then id", () => {
    expect(eventSortKey("2026-01-02T03:04:05.000Z", "evt_9")).toBe(
      "2026-01-02T03:04:05.000Z#evt_9",
    );
  });

  it("defaults to the rgs tenant", () => {
    expect(DEFAULT_TENANT_ID).toBe("rgs");
  });

  // The standing rule: keys.ts is the only file allowed to write a CRM
  // DynamoDB key literal. A copy of "META" elsewhere is a second definition of
  // the storage layout, free to drift from this one.
  //
  // Every quote JavaScript has, not just the double one: the guard used to
  // require a leading `"`, so a template literal — the very form a key built
  // from a tenant id takes — walked straight past it.
  const KEY_LITERAL_PATTERN = /["'`](META|APPLICANT#|NOTE#|EVENT#|TENANT#)/g;

  function keyLiteralsIn(source: string): string[] {
    return source.match(KEY_LITERAL_PATTERN) ?? [];
  }

  it("catches a key literal whichever quote it is written with", () => {
    expect(keyLiteralsIn('const sortKey = "META";')).toHaveLength(1);
    expect(keyLiteralsIn("const sortKey = 'META';")).toHaveLength(1);
    expect(keyLiteralsIn("const sortKey = `META`;")).toHaveLength(1);
    // The shape that motivated this: an interpolated partition key.
    expect(keyLiteralsIn("const partitionKey = `TENANT#${tenantId}#CASE#${caseId}`;")).toHaveLength(
      1,
    );
    expect(keyLiteralsIn("const applicantKey = `APPLICANT#${index}`;")).toHaveLength(1);
  });

  it("does not fire on prose that merely names a key", () => {
    expect(keyLiteralsIn("// the META item carries the case body")).toEqual([]);
    expect(keyLiteralsIn("import { META_SORT_KEY } from './keys';")).toEqual([]);
  });

  it("is the only CRM domain file that writes a key literal", async () => {
    const domainDirectory = new URL("../../src/domain/crm/", import.meta.url);
    const domainFileNames = (await readdir(domainDirectory)).filter(
      (fileName) => fileName.endsWith(".ts") && fileName !== "keys.ts",
    );
    expect(domainFileNames.length).toBeGreaterThan(0);

    for (const fileName of domainFileNames) {
      const source = await readFile(new URL(fileName, domainDirectory), "utf8");
      const keyLiterals = keyLiteralsIn(source);
      expect({ fileName, keyLiterals }).toEqual({ fileName, keyLiterals: [] });
    }
  });
});
