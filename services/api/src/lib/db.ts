import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

/** A single-table item. PK/SK required; GSI attributes optional. */
export interface TableItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  GSI3PK?: string;
  GSI3SK?: string;
  [attribute: string]: unknown;
}

export interface QueryOptions {
  skPrefix?: string;
  limit?: number;
  scanForward?: boolean;
  /**
   * Opt-in strongly consistent read. Off by default, so no existing caller
   * changes behaviour; DynamoDB only offers it on the base table, so it is
   * ignored on a GSI query (and InMemoryTableClient is always consistent).
   */
  consistentRead?: boolean;
}

/**
 * The only knob a single-item read has. Same opt-in as QueryOptions, and for
 * the same reason: an eventually consistent get can miss an item that was
 * written moments earlier, which reads back as a record that does not exist.
 */
export interface GetOptions {
  consistentRead?: boolean;
}

export interface TableClient {
  get(
    partitionKey: string,
    sortKey: string,
    options?: GetOptions,
  ): Promise<TableItem | undefined>;
  put(item: TableItem): Promise<void>;
  delete(partitionKey: string, sortKey: string): Promise<void>;
  query(partitionKey: string, options?: QueryOptions): Promise<TableItem[]>;
  queryGsi(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options?: QueryOptions,
  ): Promise<TableItem[]>;
}

/** Production adapter over DynamoDB. */
export class DynamoTableClient implements TableClient {
  private readonly documentClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    dynamoClient: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.documentClient = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(
    partitionKey: string,
    sortKey: string,
    options: GetOptions = {},
  ): Promise<TableItem | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: partitionKey, SK: sortKey },
        ConsistentRead: options.consistentRead,
      }),
    );
    return result.Item as TableItem | undefined;
  }

  async put(item: TableItem): Promise<void> {
    await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async delete(partitionKey: string, sortKey: string): Promise<void> {
    await this.documentClient.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: partitionKey, SK: sortKey } }),
    );
  }

  async query(partitionKey: string, options: QueryOptions = {}): Promise<TableItem[]> {
    return this.runQuery(undefined, "PK", "SK", partitionKey, options);
  }

  async queryGsi(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: QueryOptions = {},
  ): Promise<TableItem[]> {
    return this.runQuery(indexName, `${indexName}PK`, `${indexName}SK`, partitionKey, options);
  }

  /**
   * Drains every page. DynamoDB caps one Query response at 1 MB and reports
   * the rest through LastEvaluatedKey, so reading a single page silently
   * truncates a large partition — and a lookup that concludes "no match" from
   * a truncated page goes on to create a duplicate. A caller-supplied limit
   * still caps the total, and each follow-up page asks only for what that
   * limit still needs.
   */
  private async runQuery(
    indexName: string | undefined,
    pkAttribute: string,
    skAttribute: string,
    partitionKey: string,
    options: QueryOptions,
  ): Promise<TableItem[]> {
    const hasSkPrefix = options.skPrefix !== undefined;
    const collectedItems: TableItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const remainingLimit =
        options.limit === undefined ? undefined : options.limit - collectedItems.length;
      const result = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: indexName,
          KeyConditionExpression: hasSkPrefix
            ? `#pk = :pk AND begins_with(#sk, :skPrefix)`
            : `#pk = :pk`,
          ExpressionAttributeNames: hasSkPrefix
            ? { "#pk": pkAttribute, "#sk": skAttribute }
            : { "#pk": pkAttribute },
          ExpressionAttributeValues: hasSkPrefix
            ? { ":pk": partitionKey, ":skPrefix": options.skPrefix }
            : { ":pk": partitionKey },
          Limit: remainingLimit,
          ScanIndexForward: options.scanForward ?? true,
          // A GSI is eventually consistent by definition; asking for a
          // consistent read there is an error, so the flag is base-table only.
          ConsistentRead: indexName === undefined ? options.consistentRead : undefined,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      collectedItems.push(...((result.Items ?? []) as TableItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (
      exclusiveStartKey !== undefined &&
      (options.limit === undefined || collectedItems.length < options.limit)
    );

    return options.limit === undefined ? collectedItems : collectedItems.slice(0, options.limit);
  }
}

/**
 * Test adapter: same contract, backed by an array. Always strongly consistent
 * and never paged, so `consistentRead` is accepted and ignored here.
 */
export class InMemoryTableClient implements TableClient {
  private items = new Map<string, TableItem>();

  private static itemKey(partitionKey: string, sortKey: string): string {
    // The separator is written as the escape \u0000 rather than a raw NUL
    // byte: a raw one makes git classify this whole file as binary, and then
    // db.ts stops being reviewable by diff. The runtime string is identical.
    return `${partitionKey}\u0000${sortKey}`;
  }

  async get(
    partitionKey: string,
    sortKey: string,
    _options: GetOptions = {},
  ): Promise<TableItem | undefined> {
    return this.items.get(InMemoryTableClient.itemKey(partitionKey, sortKey));
  }

  async put(item: TableItem): Promise<void> {
    this.items.set(InMemoryTableClient.itemKey(item.PK, item.SK), structuredClone(item));
  }

  async delete(partitionKey: string, sortKey: string): Promise<void> {
    this.items.delete(InMemoryTableClient.itemKey(partitionKey, sortKey));
  }

  async query(partitionKey: string, options: QueryOptions = {}): Promise<TableItem[]> {
    return this.filterAndSort(
      (item) => item.PK === partitionKey,
      (item) => item.SK,
      options,
    );
  }

  async queryGsi(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: QueryOptions = {},
  ): Promise<TableItem[]> {
    const pkAttribute = `${indexName}PK` as const;
    const skAttribute = `${indexName}SK` as const;
    return this.filterAndSort(
      (item) => item[pkAttribute] === partitionKey,
      (item) => String(item[skAttribute] ?? ""),
      options,
    );
  }

  private filterAndSort(
    partitionMatch: (item: TableItem) => boolean,
    sortKeyOf: (item: TableItem) => string,
    options: QueryOptions,
  ): TableItem[] {
    let matches = [...this.items.values()].filter(partitionMatch);
    if (options.skPrefix !== undefined) {
      const requiredPrefix = options.skPrefix;
      matches = matches.filter((item) => sortKeyOf(item).startsWith(requiredPrefix));
    }
    matches.sort((left, right) => sortKeyOf(left).localeCompare(sortKeyOf(right)));
    if (options.scanForward === false) matches.reverse();
    if (options.limit !== undefined) matches = matches.slice(0, options.limit);
    return matches.map((item) => structuredClone(item));
  }
}
