import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { CorruptRecordError } from "../../src/lib/errors";
import type { TableClient } from "../../src/lib/db";
import {
  completeCaseRefReservation,
  readCaseRefReservation,
  reserveCaseRef,
} from "../../src/domain/crm/caseRefIndex";
import { caseRefIndexPartitionKey } from "../../src/domain/crm/keys";

describe("caseRefIndex", () => {
  it("reports nothing for a ref nothing has reserved", async () => {
    const context = buildTestContext();
    expect(await readCaseRefReservation(context, "rgs", "31376")).toBeUndefined();
  });

  it("reads a reservation back as unfinished until it is completed", async () => {
    const context = buildTestContext();
    await reserveCaseRef(context, "rgs", "31376", "case_1");

    const reserved = await readCaseRefReservation(context, "rgs", "31376");
    expect(reserved!.caseId).toBe("case_1");
    // The whole point of the two-step write: "reserved" and "imported" have to
    // be distinguishable afterwards, or a run that died between them is
    // indistinguishable from one that finished, and the ref gets a second case.
    expect(reserved!.completedAt).toBeUndefined();

    await completeCaseRefReservation(context, "rgs", reserved!);
    const completed = await readCaseRefReservation(context, "rgs", "31376");
    expect(completed!.caseId).toBe("case_1");
    expect(completed!.completedAt).toBe(context.now().toISOString());
  });

  it("keeps one tenant's reservations out of another's", async () => {
    const context = buildTestContext();
    await reserveCaseRef(context, "rgs", "31376", "case_1");
    expect(await readCaseRefReservation(context, "other-tenant", "31376")).toBeUndefined();
  });

  it("reads a reservation strongly consistently, never from a stale copy", async () => {
    const context = buildTestContext();
    let consistentReadRequested: boolean | undefined;
    const watchingTable: TableClient = {
      get: (partitionKey, sortKey, options) => {
        consistentReadRequested = options?.consistentRead;
        return context.table.get(partitionKey, sortKey, options);
      },
      put: (item) => context.table.put(item),
      delete: (partitionKey, sortKey) => context.table.delete(partitionKey, sortKey),
      query: (partitionKey, options) => context.table.query(partitionKey, options),
      queryGsi: (indexName, partitionKey, options) =>
        context.table.queryGsi(indexName, partitionKey, options),
      queryGsiPage: (indexName, partitionKey, options) =>
        context.table.queryGsiPage(indexName, partitionKey, options),
    };
    const watchingContext = { ...context, table: watchingTable };
    await reserveCaseRef(context, "rgs", "31376", "case_1");
    await readCaseRefReservation(watchingContext, "rgs", "31376");
    // An eventually consistent read here reintroduces the exact index lag the
    // reservation exists to route around, and the in-memory table cannot show
    // the difference — so the flag itself is what has to be asserted.
    expect(consistentReadRequested).toBe(true);
  });

  it("raises a typed corrupt-record error for a reservation row that will not parse", async () => {
    const context = buildTestContext();
    await context.table.put({
      PK: caseRefIndexPartitionKey("rgs", "31376"),
      SK: "META",
      tenantId: "rgs",
      caseRef: "31376",
      // caseId gone: the row can no longer say which case holds the ref.
      reservedAt: "2026-07-23T10:00:00.000Z",
    });

    // Raw, a ZodError is not an ApiError and the router answers 500. Typed,
    // the importer can decide to skip the row rather than risk a duplicate.
    await expect(readCaseRefReservation(context, "rgs", "31376")).rejects.toThrow(CorruptRecordError);
  });
});
