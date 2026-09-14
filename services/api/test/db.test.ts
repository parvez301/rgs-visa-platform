import { DynamoDBClient, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import type { GetCommandInput } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoTableClient, InMemoryTableClient, type TableItem } from "../src/lib/db";

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

  it("returns only the projected attributes", async () => {
    const tableClient = buildPopulatedClient(1);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
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
});

describe("DynamoTableClient.queryGsiPage", () => {
  it("builds a ProjectionExpression with placeholder names", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
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
      startKey: { PK: "b", SK: "META" },
    });

    expect(capturedInputs[0]!.ExclusiveStartKey).toEqual({ PK: "b", SK: "META" });
  });

  it("reports no cursor when DynamoDB reports no LastEvaluatedKey", async () => {
    const { tableClient } = buildStubbedTableClient([{ Items: [{ PK: "a", SK: "META" }] }]);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 10 });

    expect(page.nextStartKey).toBeUndefined();
  });
});
