import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APPLICANT_SORT_KEY_PREFIX,
  META_SORT_KEY,
  DEFAULT_TENANT_ID,
  REVIEW_ITEM_SORT_KEY,
  applicantSortKey,
  caseIdFromPartitionKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  eventSortKey,
  memoryPartitionKey,
  partnerCasesGsi2Pk,
  partnerPartitionKey,
  passportGsi3Pk,
  reviewItemPartitionKey,
  reviewQueueGsi1Pk,
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

  it("builds tenant-scoped review-item keys", () => {
    expect(reviewItemPartitionKey("rgs", "rev_01")).toBe("TENANT#rgs#REVIEW#rev_01");
  });

  it("partitions the review queue by status so the screen loads OPEN in one query", () => {
    expect(reviewQueueGsi1Pk("rgs", "OPEN")).toBe("TENANT#rgs#REVIEW_STATUS#OPEN");
    expect(reviewQueueGsi1Pk("rgs", "APPLIED")).toBe("TENANT#rgs#REVIEW_STATUS#APPLIED");
  });

  it("keeps review items in a different keyspace from cases", () => {
    expect(reviewItemPartitionKey("rgs", "x")).not.toBe(casePartitionKey("rgs", "x"));
  });

  // One builder, not a (partitionKey, gsiKey) pair: the memory table's
  // partition key already IS the scope, so recall needs no secondary index
  // (task-9-controller-notes.md §4.1.3).
  it("partitions memory rows by their composite scope string", () => {
    expect(memoryPartitionKey("rgs", "ORG")).toBe("TENANT#rgs#CRM_MEMORY#ORG");
    expect(memoryPartitionKey("rgs", "PARTNER#p_1")).toBe("TENANT#rgs#CRM_MEMORY#PARTNER#p_1");
    expect(memoryPartitionKey("rgs", "USER#alice@rgs.local")).toBe(
      "TENANT#rgs#CRM_MEMORY#USER#alice@rgs.local",
    );
    expect(memoryPartitionKey("rgs", "ORG")).not.toBe(memoryPartitionKey("other", "ORG"));
  });

  it("scopes review keys per tenant", () => {
    expect(reviewItemPartitionKey("rgs", "rev_01")).not.toBe(reviewItemPartitionKey("other", "rev_01"));
    expect(reviewQueueGsi1Pk("rgs", "OPEN")).not.toBe(reviewQueueGsi1Pk("other", "OPEN"));
  });

  // The brief requires reviewItemPartitionKey and reviewQueueGsi1Pk plus a
  // REVIEW_ITEM_SORT_KEY export. It must reuse the shared META_SORT_KEY
  // constant rather than a second "META" literal, so a future rename of one
  // cannot silently drift from the other.
  it("reuses the shared META sort key for review items instead of a second literal", () => {
    expect(REVIEW_ITEM_SORT_KEY).toBe("META");
    expect(REVIEW_ITEM_SORT_KEY).toBe(META_SORT_KEY);
  });

  // The standing rule: keys.ts is the only file allowed to write a CRM
  // DynamoDB key literal. A copy of "META" elsewhere is a second definition of
  // the storage layout, free to drift from this one.
  //
  // Every quote JavaScript has, not just the double one: the guard used to
  // require a leading `"`, so a template literal — the very form a key built
  // from a tenant id takes — walked straight past it.
  //
  // CRM_MEMORY# (fix round 1, Minor 4): the memory keyspace's own infix,
  // added alongside the others rather than left to rely solely on the
  // TENANT# alternative catching a full literal built elsewhere.
  //
  // PREFS / CRM_USER# (task-10 fix round 1, MAJ-8): Task 10's own keyspace
  // (CRM_USER_PREFS_SORT_KEY / crmUserPrefsPartitionKey, keys.ts). Added the
  // same way CRM_MEMORY# was -- the moment this branch's convention says a
  // new keyspace gets its own alternation entry, not reliance on TENANT#
  // alone to catch a full literal built elsewhere.
  const KEY_LITERAL_PATTERN = /["'`](META|APPLICANT#|NOTE#|EVENT#|TENANT#|CRM_MEMORY#|PREFS|CRM_USER#)/g;

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
    // The memory keyspace's own infix -- would have slipped past before Minor 4's fix.
    expect(keyLiteralsIn("const memoryInfix = `CRM_MEMORY#${scope}`;")).toHaveLength(1);
    // Task 10's own keyspace -- would have slipped past before MAJ-8's fix.
    expect(keyLiteralsIn('const sortKey = "PREFS";')).toHaveLength(1);
    expect(keyLiteralsIn("const userInfix = `CRM_USER#${email}`;")).toHaveLength(1);
  });

  it("does not fire on prose that merely names a key", () => {
    expect(keyLiteralsIn("// the META item carries the case body")).toEqual([]);
    expect(keyLiteralsIn("import { META_SORT_KEY } from './keys';")).toEqual([]);
  });

  // Recursive, not a flat `readdir`: one of the two directories this scan
  // covers already has subdirectories today (src/agent/ has providers/ and
  // tools/; domain/crm/ has none yet, but nothing stops it growing one), and
  // a scan that only sees the top level would pass a key literal planted one
  // directory deeper without complaint (fix-round-2 NEW-5: this comment used
  // to claim "both...have subdirectories" and then contradict itself in its
  // own parenthesis).
  async function collectTsFilesRecursively(directoryUrl: URL): Promise<string[]> {
    const entries = await readdir(directoryUrl, { recursive: true });
    return entries.filter((entryName) => entryName.endsWith(".ts"));
  }

  it("is the only CRM domain file that writes a key literal", async () => {
    const domainDirectory = new URL("../../src/domain/crm/", import.meta.url);
    const domainFileNames = (await collectTsFilesRecursively(domainDirectory)).filter(
      (fileName) => fileName !== "keys.ts",
    );
    expect(domainFileNames.length).toBeGreaterThan(0);

    for (const fileName of domainFileNames) {
      const source = await readFile(new URL(fileName, domainDirectory), "utf8");
      const keyLiterals = keyLiteralsIn(source);
      expect({ fileName, keyLiterals }).toEqual({ fileName, keyLiterals: [] });
    }
  });

  // task-10-fix-1-brief.md B7 / review MAJ-8, overruling the review's own
  // "pre-existing, out of scope" verdict: Task 10 is what put a key-owning
  // module (prefs.ts -- CRM_USER_PREFS_SORT_KEY, crmUserPrefsPartitionKey)
  // under src/agent/, a tree this scan never covered before. Every file
  // under it is scanned, with no keys.ts-style exclusion, because nothing
  // under src/agent/ owns a key literal of its own -- prefs.ts imports the
  // builders domain/crm/keys.ts exports rather than defining any itself, and
  // that is exactly what this test exists to keep true.
  it("is also true of every file under src/agent/, which Task 10 made a key-owning tree", async () => {
    const agentDirectory = new URL("../../src/agent/", import.meta.url);
    const agentFileNames = await collectTsFilesRecursively(agentDirectory);
    expect(agentFileNames.length).toBeGreaterThan(0);

    for (const fileName of agentFileNames) {
      const source = await readFile(new URL(fileName, agentDirectory), "utf8");
      const keyLiterals = keyLiteralsIn(source);
      expect({ fileName, keyLiterals }).toEqual({ fileName, keyLiterals: [] });
    }
  });
});
