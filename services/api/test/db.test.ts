import { DynamoDBClient, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoTableClient, type TableItem } from "../src/lib/db";

interface StubbedQueryPage {
  Items: TableItem[];
  LastEvaluatedKey?: Record<string, unknown>;
}

/**
 * Short-circuits the SDK middleware stack at the initialize step, before
 * serialization, so the test sees the command input the client built and hands
 * back canned pages. Nothing leaves the process.
 */
function buildStubbedTableClient(pages: StubbedQueryPage[]): {
  tableClient: DynamoTableClient;
  capturedInputs: QueryCommandInput[];
} {
  const capturedInputs: QueryCommandInput[] = [];
  const dynamoClient = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
  });
  let servedPageCount = 0;
  dynamoClient.middlewareStack.add(
    () => async (handlerArguments) => {
      capturedInputs.push(handlerArguments.input as QueryCommandInput);
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

  it("never asks for a consistent read on a GSI, which DynamoDB rejects", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);
    await tableClient.queryGsi("GSI1", "INDEXED_PARTITION#1", { consistentRead: true });
    expect(capturedInputs[0]!.IndexName).toBe("GSI1");
    expect(capturedInputs[0]!.ConsistentRead).toBeUndefined();
  });
});
