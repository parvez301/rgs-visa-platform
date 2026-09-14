import { DynamoDBClient, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import type { GetCommandInput } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DynamoTableClient,
  InMemoryTableClient,
  type TableItem,
  type TableItemKey,
} from "../src/lib/db";

interface StubbedQueryPage {
  Items?: TableItem[];
  Item?: TableItem;
  LastEvaluatedKey?: Record<string, unknown>;
}

/**
 * Short-circuits the SDK middleware stack at the initialize step, before
 * serialization, so the test sees the command input the client built and hands
 * back canned pages. Nothing leaves the process.
 */
function buildStubbedTableClient<CapturedInput = QueryCommandInput>(
  pages: StubbedQueryPage[],
): {
  tableClient: DynamoTableClient;
  capturedInputs: CapturedInput[];
} {
  const capturedInputs: CapturedInput[] = [];
  const dynamoClient = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
  });
  let servedPageCount = 0;
  dynamoClient.middlewareStack.add(
    () => async (handlerArguments) => {
      capturedInputs.push(handlerArguments.input as CapturedInput);
      const page = pages[servedPageCount] ?? { Items: [] };
      servedPageCount += 1;
      return { output: { ...page, $metadata: {} }, response: undefined };
    },
    { step: "initialize", priority: "high", name: "stubbedTransport" },
  );
  return { tableClient: new DynamoTableClient("rgs-test-table", dynamoClient), capturedInputs };
}

function buildItem(sortKey: string): TableItem {
  return { PK: "PARTITION#1", SK: sortKey };
}

const NEW_STATUS_PARTITION = "TENANT#rgs#CASE_STATUS#NEW";

function caseIdsOf(items: TableItem[]): string[] {
  return items.map((item) => String(item["caseId"]));
}

/**
 * A case changes status. GSI1 partitions cases BY caseStatus, so the row does
 * not disappear -- it moves to a different GSI1 partition, which from the
 * reading partition's point of view is indistinguishable from a delete.
 */
async function moveCaseToAnotherStatusPartition(
  tableClient: InMemoryTableClient,
  caseId: string,
): Promise<void> {
  const storedCase = await tableClient.get(`TENANT#rgs#CASE#${caseId}`, "META");
  if (storedCase === undefined) throw new Error(`no META item seeded for ${caseId}`);
  await tableClient.put({ ...storedCase, GSI1PK: "TENANT#rgs#CASE_STATUS#IN_PROGRESS" });
}

describe("DynamoTableClient query paging", () => {
  it("follows LastEvaluatedKey until the pages run out", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([
      { Items: [buildItem("ITEM#00")], LastEvaluatedKey: { PK: "p", SK: "ITEM#00" } },
      { Items: [buildItem("ITEM#01")], LastEvaluatedKey: { PK: "p", SK: "ITEM#01" } },
      { Items: [buildItem("ITEM#02")] },
    ]);

    const items = await tableClient.query("PARTITION#1");

    // Past DynamoDB's 1 MB page, a single-page read silently truncates.
    expect(items.map((item) => item.SK)).toEqual([
      "ITEM#00",
      "ITEM#01",
      "ITEM#02",
    ]);
    expect(capturedInputs).toHaveLength(3);
    expect(capturedInputs[0]!.ExclusiveStartKey).toBeUndefined();
    expect(capturedInputs[1]!.ExclusiveStartKey).toEqual({ PK: "p", SK: "ITEM#00" });
    expect(capturedInputs[2]!.ExclusiveStartKey).toEqual({ PK: "p", SK: "ITEM#01" });
  });

  it("stops at the requested limit instead of draining every page", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([
      {
        Items: [buildItem("ITEM#00"), buildItem("ITEM#01")],
        LastEvaluatedKey: { PK: "p", SK: "ITEM#01" },
      },
      { Items: [buildItem("ITEM#02")] },
    ]);

    const items = await tableClient.query("PARTITION#1", { limit: 2 });

    expect(items.map((item) => item.SK)).toEqual(["ITEM#00", "ITEM#01"]);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.Limit).toBe(2);
  });

  it("asks the next page only for the items the limit still needs", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([
      { Items: [buildItem("ITEM#00")], LastEvaluatedKey: { PK: "p", SK: "ITEM#00" } },
      { Items: [buildItem("ITEM#01"), buildItem("ITEM#02")] },
    ]);

    const items = await tableClient.query("PARTITION#1", { limit: 3 });

    expect(items).toHaveLength(3);
    expect(capturedInputs[0]!.Limit).toBe(3);
    expect(capturedInputs[1]!.Limit).toBe(2);
  });
});

describe("DynamoTableClient consistent reads", () => {
  it("leaves ConsistentRead unset unless the caller opts in", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);
    await tableClient.query("PARTITION#1");
    expect(capturedInputs[0]!.ConsistentRead).toBeUndefined();
  });

  it("asks for a consistent read when the caller opts in", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);
    await tableClient.query("PARTITION#1", { consistentRead: true });
    expect(capturedInputs[0]!.ConsistentRead).toBe(true);
  });

  it("leaves ConsistentRead unset on a get unless the caller opts in", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient<GetCommandInput>([{}]);
    await tableClient.get("PARTITION#1", "META");
    expect(capturedInputs[0]!.ConsistentRead).toBeUndefined();
  });

  it("asks for a consistent read on a get when the caller opts in", async () => {
    // The CRM's META reads use this: an eventually consistent get can miss an
    // item that was just written and report a live record as missing.
    const { tableClient, capturedInputs } = buildStubbedTableClient<GetCommandInput>([{}]);
    await tableClient.get("PARTITION#1", "META", { consistentRead: true });
    expect(capturedInputs[0]!.ConsistentRead).toBe(true);
  });

  it("never asks for a consistent read on a GSI, which DynamoDB rejects", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);
    await tableClient.queryGsi("GSI1", "INDEXED_PARTITION#1", { consistentRead: true });
    expect(capturedInputs[0]!.IndexName).toBe("GSI1");
    expect(capturedInputs[0]!.ConsistentRead).toBeUndefined();
  });
});

describe("InMemoryTableClient projection and paging", () => {
  function buildPopulatedClient(itemCount: number): InMemoryTableClient {
    const tableClient = new InMemoryTableClient();
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const paddedIndex = String(itemIndex).padStart(3, "0");
      void tableClient.put({
        PK: `TENANT#rgs#CASE#case_${paddedIndex}`,
        SK: "META",
        GSI1PK: "TENANT#rgs#CASE_STATUS#NEW",
        GSI1SK: `2026-03-01T00:00:${paddedIndex.slice(1)}.000Z`,
        caseId: `case_${paddedIndex}`,
        caseRef: `RGS-${paddedIndex}`,
        legacyRaw: { STATUS: "a very long original spreadsheet row" },
      });
    }
    return tableClient;
  }

  /**
   * Every row shares one GSI1SK, which a bulk import stamping one timestamp
   * across a whole spreadsheet produces routinely. Written in an order that is
   * deliberately NOT the key order: with the sort key tied for every row, an
   * adapter that leaves ties in insertion order serves them in an order its own
   * cursor comparison disagrees with, and rows go missing.
   */
  function buildClientWithTiedSortKeys(caseIdsInWriteOrder: readonly string[]): InMemoryTableClient {
    const tableClient = new InMemoryTableClient();
    for (const caseId of caseIdsInWriteOrder) {
      void tableClient.put({
        PK: `TENANT#rgs#CASE#${caseId}`,
        SK: "META",
        GSI1PK: NEW_STATUS_PARTITION,
        GSI1SK: "2026-03-01T00:00:00.000Z",
        caseId,
      });
    }
    return tableClient;
  }

  it("returns only the projected attributes", async () => {
    const tableClient = buildPopulatedClient(1);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 1,
      projection: ["PK", "SK", "caseId", "caseRef"],
    });

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual(["PK", "SK", "caseId", "caseRef"].sort());
    expect(page.items[0]!["legacyRaw"]).toBeUndefined();
  });

  it("resumes exactly after the cursor, with no row read twice and none skipped", async () => {
    const tableClient = buildPopulatedClient(10);

    const firstPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 4 });
    expect(firstPage.items).toHaveLength(4);
    expect(firstPage.nextStartKey).toBeDefined();

    const secondPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 4,
      startKey: firstPage.nextStartKey,
    });
    const thirdPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 4,
      startKey: secondPage.nextStartKey,
    });

    const readCaseIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
      (item) => item["caseId"],
    );
    expect(readCaseIds).toHaveLength(10);
    expect(new Set(readCaseIds).size).toBe(10);
    expect(thirdPage.nextStartKey).toBeUndefined();
  });

  it("reports no cursor when the partition fits in one page", async () => {
    const tableClient = buildPopulatedClient(3);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 50 });

    expect(page.items).toHaveLength(3);
    expect(page.nextStartKey).toBeUndefined();
  });

  it("honours scanForward: false and still resumes correctly", async () => {
    const tableClient = buildPopulatedClient(6);

    const firstPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 2,
      scanForward: false,
    });
    const secondPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 2,
      scanForward: false,
      startKey: firstPage.nextStartKey,
    });

    expect(firstPage.items.map((item) => item["caseId"])).toEqual(["case_005", "case_004"]);
    expect(secondPage.items.map((item) => item["caseId"])).toEqual(["case_003", "case_002"]);
  });

  it("does not rewind when the cursor row leaves the partition between two pages", async () => {
    const tableClient = buildPopulatedClient(6);

    const firstPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 3 });
    expect(caseIdsOf(firstPage.items)).toEqual(["case_000", "case_001", "case_002"]);

    await moveCaseToAnotherStatusPartition(tableClient, "case_002");

    const secondPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 3,
      startKey: firstPage.nextStartKey,
    });

    // Resuming by identity made "the cursor row is gone" (findIndex -> -1)
    // identical to "start from the beginning" (-1 + 1 === 0), re-serving rows
    // the caller already had. DynamoDB's ExclusiveStartKey resumes by position
    // and never requires the cursor row to still exist.
    expect(caseIdsOf(secondPage.items)).toEqual(["case_003", "case_004", "case_005"]);
    const firstPageCaseIds = caseIdsOf(firstPage.items);
    expect(caseIdsOf(secondPage.items).filter((caseId) => firstPageCaseIds.includes(caseId))).toEqual(
      [],
    );
    const everyCaseIdRead = [...firstPageCaseIds, ...caseIdsOf(secondPage.items)];
    expect(new Set(everyCaseIdRead).size).toBe(everyCaseIdRead.length);
  });

  it("does not rewind when the cursor row is deleted between two pages", async () => {
    const tableClient = buildPopulatedClient(6);

    const firstPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 3 });
    expect(caseIdsOf(firstPage.items)).toEqual(["case_000", "case_001", "case_002"]);

    await tableClient.delete("TENANT#rgs#CASE#case_002", "META");

    const secondPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 3,
      startKey: firstPage.nextStartKey,
    });

    expect(caseIdsOf(secondPage.items)).toEqual(["case_003", "case_004", "case_005"]);
    const firstPageCaseIds = caseIdsOf(firstPage.items);
    expect(caseIdsOf(secondPage.items).filter((caseId) => firstPageCaseIds.includes(caseId))).toEqual(
      [],
    );
    const everyCaseIdRead = [...firstPageCaseIds, ...caseIdsOf(secondPage.items)];
    expect(new Set(everyCaseIdRead).size).toBe(everyCaseIdRead.length);
  });

  it("reports an exhausted partition for a cursor past the end, not a rewind", async () => {
    const tableClient = buildPopulatedClient(4);

    const wholePartition = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 4,
    });
    expect(wholePartition.nextStartKey).toBeUndefined();
    const lastRow = wholePartition.items[wholePartition.items.length - 1];
    const cursorAtTheEnd: TableItemKey = {
      PK: lastRow!.PK,
      SK: lastRow!.SK,
      GSI1PK: lastRow!["GSI1PK"],
      GSI1SK: lastRow!["GSI1SK"],
    };

    const pageFromTheEnd = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 4,
      startKey: cursorAtTheEnd,
    });
    expect(pageFromTheEnd.items).toEqual([]);
    expect(pageFromTheEnd.nextStartKey).toBeUndefined();

    // And still exhausted once that last row leaves: -1 from the position
    // search means "nothing after the cursor", which is the opposite of where
    // the old `+ 1` sent it.
    await moveCaseToAnotherStatusPartition(tableClient, "case_003");
    const pageAfterTheRowLeft = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 4,
      startKey: cursorAtTheEnd,
    });
    expect(pageAfterTheRowLeft.items).toEqual([]);
    expect(pageAfterTheRowLeft.nextStartKey).toBeUndefined();
  });

  it("serves every row of a sort-key tie exactly once while paging across it", async () => {
    const tableClient = buildClientWithTiedSortKeys([
      "case_003",
      "case_001",
      "case_000",
      "case_002",
    ]);

    const readCaseIds: string[] = [];
    let cursor: TableItemKey | undefined;
    for (let pageNumber = 1; pageNumber <= 8; pageNumber += 1) {
      const page = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
        limit: 1,
        startKey: cursor,
      });
      readCaseIds.push(...caseIdsOf(page.items));
      cursor = page.nextStartKey;
      if (cursor === undefined) break;
      // The row just served changes status. Every row here shares one GSI1SK,
      // so a cursor that carried only the sort key could not tell the served
      // rows from the unread ones -- which is why the position a cursor indexes
      // has to include the base-table key.
      if (pageNumber === 2) await moveCaseToAnotherStatusPartition(tableClient, "case_001");
    }

    expect(readCaseIds).toEqual(["case_000", "case_001", "case_002", "case_003"]);
    expect(new Set(readCaseIds).size).toBe(readCaseIds.length);
  });

  it("hands back a cursor carrying the index key as well as the base-table key", async () => {
    const tableClient = buildPopulatedClient(4);

    const page = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 2 });

    // The shape DynamoDB hands back off a GSI query. Not cosmetic: resuming by
    // position reads the index sort key straight off the cursor, so a double
    // that omits it cannot be resumed the way the real thing is.
    expect(page.nextStartKey).toEqual({
      PK: "TENANT#rgs#CASE#case_001",
      SK: "META",
      GSI1PK: NEW_STATUS_PARTITION,
      GSI1SK: "2026-03-01T00:00:01.000Z",
    });
  });

  it("throws on a non-positive limit instead of reporting a live partition exhausted", async () => {
    const tableClient = buildPopulatedClient(3);

    // Paired with the DynamoTableClient test below, and the PAIR is the point:
    // a guard on one adapter only is the seam, not the fix. `limit: 0` used to
    // be an empty page with no cursor here -- a partition reported exhausted
    // that is not -- and a ValidationException on the wire over there.
    await expect(
      tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 0 }),
    ).rejects.toThrow("queryGsiPage needs a positive integer limit, got 0");
  });

  it("does not rewind on a backward scan when the cursor row leaves the partition", async () => {
    const tableClient = buildPopulatedClient(6);

    const firstPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 3,
      scanForward: false,
    });
    expect(caseIdsOf(firstPage.items)).toEqual(["case_005", "case_004", "case_003"]);

    await moveCaseToAnotherStatusPartition(tableClient, "case_003");

    const secondPage = await tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, {
      limit: 3,
      scanForward: false,
      startKey: firstPage.nextStartKey,
    });

    // The position comparison flips with the scan direction, so an inverted
    // sign here reads as either a rewind to the newest row or an empty page.
    expect(caseIdsOf(secondPage.items)).toEqual(["case_002", "case_001", "case_000"]);
    expect(secondPage.nextStartKey).toBeUndefined();
  });
});

/**
 * DynamoDB sorts keys by UTF-8 byte order. `String.prototype.localeCompare` is
 * an ICU linguistic collation and disagrees with byte order on four of five
 * probed pairs, including two shapes this repo builds keys from every day:
 * `#` against `_` -- `TENANT#rgs#CASE#a` and `TENANT#rgs#CASE_REF#a` are
 * ordered OPPOSITE by ICU, and both infixes are real in domain/crm/keys.ts --
 * and a sort key that is a prefix of another. ICU also treats U+0000 as
 * completely ignorable, so it silently unjoins the fields of a composite key.
 *
 * These tests pin the comparator. Do not "fix" them back to localeCompare.
 */
describe("InMemoryTableClient orders keys the way DynamoDB does", () => {
  const LEDGER_PARTITION = "TENANT#rgs#CASE_STATUS#NEW";

  it("orders a GSI page by byte order where ICU collation disagrees", async () => {
    const tableClient = new InMemoryTableClient();
    // Byte order: digits before letters, then `#` (35) before `_` (95), and a
    // sort key that is a prefix of another sorts first.
    const sortKeysInByteOrder = ["2026-03-01", "2026-03-01T09:00:00Z", "CASE#a", "CASE_REF#a"];
    // Written in neither the byte order nor the ICU order.
    for (const indexSortKey of ["CASE_REF#a", "2026-03-01T09:00:00Z", "CASE#a", "2026-03-01"]) {
      void tableClient.put({
        PK: `TENANT#rgs#CASE#case_${indexSortKey}`,
        SK: "META",
        GSI1PK: LEDGER_PARTITION,
        GSI1SK: indexSortKey,
      });
    }

    const page = await tableClient.queryGsiPage("GSI1", LEDGER_PARTITION, { limit: 10 });

    expect(page.items.map((item) => String(item["GSI1SK"]))).toEqual(sortKeysInByteOrder);
  });

  it("pages a sort-key tie once per row when the order is decided at the key boundary", async () => {
    const tableClient = new InMemoryTableClient();
    const tiedIndexSortKey = "2026-03-01T00:00:00.000Z";
    // case_1 and case_12: one base partition key is a prefix of the other, so
    // the ordering is decided exactly at the PK/SK boundary -- which is where
    // the NUL separator has to do its job. Concatenated without a separator
    // (which is what ICU does, treating NUL as completely ignorable) these two
    // compare the other way round, because `TRAVELLER#...` then meets `2`
    // rather than the separator.
    const baseKeysInWriteOrder = [
      { PK: "TENANT#rgs#CASE#case_12", SK: "TRAVELLER#a" },
      { PK: "TENANT#rgs#CASE#case_1", SK: "TRAVELLER#z" },
    ];
    for (const baseKey of baseKeysInWriteOrder) {
      void tableClient.put({ ...baseKey, GSI1PK: LEDGER_PARTITION, GSI1SK: tiedIndexSortKey });
    }

    const readBaseKeys: string[] = [];
    let cursor: TableItemKey | undefined;
    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
      const page = await tableClient.queryGsiPage("GSI1", LEDGER_PARTITION, {
        limit: 1,
        startKey: cursor,
      });
      readBaseKeys.push(...page.items.map((item) => `${item.PK}|${item.SK}`));
      cursor = page.nextStartKey;
      if (cursor === undefined) break;
    }

    expect(readBaseKeys).toEqual([
      "TENANT#rgs#CASE#case_1|TRAVELLER#z",
      "TENANT#rgs#CASE#case_12|TRAVELLER#a",
    ]);
    expect(new Set(readBaseKeys).size).toBe(readBaseKeys.length);
  });

  it("orders a base-table query by byte order where ICU collation disagrees", async () => {
    const tableClient = new InMemoryTableClient();
    // The measured disagreement, pinned: `#` is byte 35 and `_` is byte 95, so
    // DynamoDB returns CASE#a first. ICU returns CASE_REF#a first. This is the
    // `filterAndSort` path, which backs query and queryGsi -- i.e. nearly every
    // read the whole test suite makes.
    for (const sortKey of ["CASE_REF#a", "CASE#a"]) {
      void tableClient.put({ PK: "TENANT#rgs#LOOKUP", SK: sortKey });
    }

    const items = await tableClient.query("TENANT#rgs#LOOKUP");

    expect(items.map((item) => item.SK)).toEqual(["CASE#a", "CASE_REF#a"]);
  });
});

describe("DynamoTableClient.queryGsiPage", () => {
  it("builds a ProjectionExpression with placeholder names", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 10,
      projection: ["PK", "caseStatus"],
    });

    const [queryInput] = capturedInputs;
    // Placeholders, never raw names: `status`-like attribute names are
    // DynamoDB reserved words and a raw ProjectionExpression 400s on them.
    expect(queryInput!.ProjectionExpression).toBe("#p0, #p1");
    expect(queryInput!.ExpressionAttributeNames).toMatchObject({
      "#p0": "PK",
      "#p1": "caseStatus",
      "#pk": "GSI1PK",
    });
  });

  it("stops at the limit instead of draining, and returns the key to resume from", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([
      { Items: [{ PK: "a", SK: "META" }, { PK: "b", SK: "META" }], LastEvaluatedKey: { PK: "b", SK: "META" } },
      { Items: [{ PK: "c", SK: "META" }] },
    ]);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 2 });

    expect(page.items.map((item) => item.PK)).toEqual(["a", "b"]);
    expect(page.nextStartKey).toEqual({ PK: "b", SK: "META" });
    // The second page must never have been requested. This is the half of the
    // claim that separates queryGsiPage from runQuery, and asserting only the
    // returned items would pass with a drained query too.
    expect(capturedInputs).toHaveLength(1);
  });

  it("forwards a supplied startKey as ExclusiveStartKey", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 10,
      startKey: { PK: "b", SK: "META" },
    });

    expect(capturedInputs[0]!.ExclusiveStartKey).toEqual({ PK: "b", SK: "META" });
  });

  it("reports no cursor when DynamoDB reports no LastEvaluatedKey", async () => {
    const { tableClient } = buildStubbedTableClient([{ Items: [{ PK: "a", SK: "META" }] }]);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 10 });

    expect(page.nextStartKey).toBeUndefined();
  });

  it("throws on a non-positive limit before any command reaches the wire", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    // The twin of the InMemoryTableClient test above, and the PAIR is the
    // point: DynamoDB's Query rejects Limit < 1 with a ValidationException, so
    // a guard on the double alone would leave the failure production-only.
    await expect(
      tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      tableClient.queryGsiPage("GSI1", NEW_STATUS_PARTITION, { limit: 0 }),
    ).rejects.toThrow("queryGsiPage needs a positive integer limit, got 0");
    // It must throw BEFORE the wire, not after: a rejected send is a round trip
    // and a 400 in CloudWatch either way.
    expect(capturedInputs).toEqual([]);
  });
});
