import { describe, expect, it, vi } from "vitest";
import { buildTestContext } from "../helpers";
import { readCase, readCaseOrThrow, writeCase } from "../../src/domain/crm/caseStore";
import { CorruptRecordError } from "../../src/lib/errors";
import { APPLICANT_SORT_KEY_PREFIX, casePartitionKey } from "../../src/domain/crm/keys";
import type { crm } from "@rgs/shared";

function buildCase(overrides: Partial<crm.CrmCase> = {}): crm.CrmCase {
  return {
    tenantId: "rgs",
    caseId: "case_1",
    caseRef: "31377",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "BH",
    visaType: "EVISA_TOURIST",
    entryType: "SINGLE",
    processing: "NORMAL",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-02",
    lineItems: [],
    totalInr: 0,
    watchdogOverrides: {},
    mutedRules: [],
    applicants: [
      { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "31378", travellerId: "trv_2", custody: "NOT_HELD", outcome: "PENDING" },
    ],
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  } as crm.CrmCase;
}

describe("caseStore", () => {
  it("stores each applicant as its own item, not a nested array", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const partitionKey = casePartitionKey("rgs", "case_1");
    const metaItem = await context.table.get(partitionKey, "META");
    expect(metaItem).toBeDefined();
    // The storage shape must NOT carry the applicants array.
    expect(metaItem!["applicants"]).toBeUndefined();

    const applicantItems = await context.table.query(partitionKey, {
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
    });
    expect(applicantItems).toHaveLength(2);
    expect(applicantItems[0]!["applicantRef"]).toBe("31377");
    expect(applicantItems[1]!["applicantRef"]).toBe("31378");
  });

  it("reassembles the domain shape on read", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const loaded = await readCase(context, "rgs", "case_1");
    expect(loaded).toBeDefined();
    expect(loaded!.applicants).toHaveLength(2);
    expect(loaded!.applicants[0]!.applicantRef).toBe("31377");
    expect(loaded!.caseRef).toBe("31377");
    expect(loaded!.destinationCountry).toBe("BH");
  });

  it("round-trips without losing or inventing a field", async () => {
    const context = buildTestContext();
    const original = buildCase();
    await writeCase(context, original);
    const loaded = await readCase(context, "rgs", "case_1");
    expect(loaded).toEqual(original);
  });

  it("removes applicant items that are no longer part of the case", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const shrunk = buildCase({
      applicants: [
        { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
      ],
    } as Partial<crm.CrmCase>);
    await writeCase(context, shrunk);

    const loaded = await readCase(context, "rgs", "case_1");
    // Without the delete pass, a ghost second applicant survives here.
    expect(loaded!.applicants).toHaveLength(1);
    const applicantItems = await context.table.query(casePartitionKey("rgs", "case_1"), {
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
    });
    expect(applicantItems).toHaveLength(1);
  });

  it("re-reads the applicant items consistently before deleting the ghosts", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const querySpy = vi.spyOn(context.table, "query");
    let queryOptions: unknown;
    try {
      await writeCase(
        context,
        buildCase({
          applicants: [
            { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
          ],
        } as Partial<crm.CrmCase>),
      );
      // Read before restoring: mockRestore also clears the recorded calls.
      expect(querySpy).toHaveBeenCalledTimes(1);
      queryOptions = querySpy.mock.calls[0]![1];
    } finally {
      querySpy.mockRestore();
    }

    // An eventually consistent read here can miss the item it is about to
    // delete, leaving a ghost applicant that blocks DECIDED and CLOSED for
    // good. InMemoryTableClient is always consistent, so only the request
    // itself can show the bug.
    expect(queryOptions).toEqual({
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
      consistentRead: true,
    });
  });

  it("re-reads the applicant items consistently when reassembling a case", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const querySpy = vi.spyOn(context.table, "query");
    let queryOptions: unknown;
    try {
      await readCase(context, "rgs", "case_1");
      // Read before restoring: mockRestore also clears the recorded calls.
      expect(querySpy).toHaveBeenCalledTimes(1);
      queryOptions = querySpy.mock.calls[0]![1];
    } finally {
      querySpy.mockRestore();
    }

    // An eventually consistent miss here hands back applicants: [] for a
    // perfectly healthy case, which readCase reports as CorruptRecordError and
    // the list endpoint then skips — a live case silently leaves the queue.
    // InMemoryTableClient is always consistent, so only the request itself can
    // show the bug.
    expect(queryOptions).toEqual({
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
      consistentRead: true,
    });
  });

  it("reads the case META item consistently, exactly as it reads the applicants", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const getSpy = vi.spyOn(context.table, "get");
    let getOptions: unknown;
    try {
      await readCase(context, "rgs", "case_1");
      // Read before restoring: mockRestore also clears the recorded calls.
      expect(getSpy).toHaveBeenCalledTimes(1);
      getOptions = getSpy.mock.calls[0]![2];
    } finally {
      getSpy.mockRestore();
    }

    // The same defect class as the two reads above, one level up: an
    // eventually consistent META read can miss the item that was just written,
    // and readCase then reports a perfectly healthy case as missing — a 404 on
    // the single-case route, or a false entry in unreadableCaseIds on the
    // listing. InMemoryTableClient is always consistent, so only the request
    // itself can show the bug.
    expect(getOptions).toEqual({ consistentRead: true });
  });

  it("indexes the case by status and by partner", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), "META");
    expect(metaItem!["GSI1PK"]).toBe("TENANT#rgs#CASE_STATUS#NEW");
    expect(metaItem!["GSI2PK"]).toBe("TENANT#rgs#PARTNER#partner_1");
    expect(metaItem!["GSI2SK"]).toBe("2026-01-02");
  });

  it("returns undefined for a case that does not exist", async () => {
    const context = buildTestContext();
    expect(await readCase(context, "rgs", "nope")).toBeUndefined();
  });

  it("does not leak a case across tenants", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    expect(await readCase(context, "other-tenant", "case_1")).toBeUndefined();
  });

  it("throws a 404 from readCaseOrThrow when missing", async () => {
    const context = buildTestContext();
    await expect(readCaseOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("reports a typed failure for a partition that holds META but no applicants", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    // A Lambda timeout (or one throttled PutItem) between the META write and
    // the applicant writes leaves exactly this half-written partition.
    await writeCase(context, buildCase({ applicants: [] } as Partial<crm.CrmCase>));
    const partitionKey = casePartitionKey("rgs", "case_1");
    expect(await context.table.get(partitionKey, "META")).toBeDefined();
    expect(
      await context.table.query(partitionKey, { skPrefix: APPLICANT_SORT_KEY_PREFIX }),
    ).toHaveLength(0);

    // A raw ZodError here escapes the router's ApiError mapping as a 500.
    await expect(readCase(context, "rgs", "case_1")).rejects.toBeInstanceOf(CorruptRecordError);
    await expect(readCase(context, "rgs", "case_1")).rejects.toMatchObject({
      statusCode: 409,
      code: "CORRUPT_RECORD",
    });
  });

  it("names the unreadable case in the failure, so an operator can find it", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    await writeCase(context, buildCase({ applicants: [] } as Partial<crm.CrmCase>));
    await expect(readCase(context, "rgs", "case_1")).rejects.toThrow(/case_1/);
  });

  it("does not fabricate an empty applicant list for a half-written partition", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    await writeCase(context, buildCase({ applicants: [] } as Partial<crm.CrmCase>));
    // Returning a case with applicants: [] would present a corrupt case as healthy.
    await expect(readCase(context, "rgs", "case_1")).rejects.toBeInstanceOf(CorruptRecordError);
  });

  it("preserves applicant order across the single/double-digit boundary", async () => {
    const context = buildTestContext();
    // Build a case with 11 applicants to cross the APPLICANT#09 / APPLICANT#10 boundary.
    // Each applicant has a unique passportNumber so position is identifiable.
    const applicantsWithDistinctIds = Array.from({ length: 11 }, (_, i) => ({
      applicantRef: String(30000 + i),
      travellerId: `trv_${i}`,
      custody: "NOT_HELD" as const,
      outcome: "PENDING" as const,
      passportNumber: `PASSPORT_${String(i).padStart(2, "0")}`,
    }));

    const original = buildCase({
      applicants: applicantsWithDistinctIds,
    } as Partial<crm.CrmCase>);

    await writeCase(context, original);
    const loaded = await readCase(context, "rgs", "case_1");

    // Deeply equal array assertion catches order mismatches.
    // Without 2-digit padding, APPLICANT#10 would sort before APPLICANT#09,
    // and loaded.applicants would be reordered, failing this assertion.
    expect(loaded!.applicants).toEqual(original.applicants);
  });
});
