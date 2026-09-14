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
  /**
   * Attribute names to return instead of the whole item. Every GSI in this
   * stack is ProjectionType.ALL, so this reduces response bytes rather than
   * index coverage -- which is the whole point on the Ledger read, where the
   * difference is 1.4 MB against 7-21 MB. Always include PK and SK: callers
   * filter on SK and recover a caseId from PK.
   */
  projection?: readonly string[];
}

/** A DynamoDB primary/index key, as both adapters hand it back. */
export type TableItemKey = Record<string, unknown>;

/** One page of a partition, plus where to resume if there is more. */
export interface QueryPage {
  items: TableItem[];
  /** Absent when the partition is exhausted -- never an empty object. */
  nextStartKey?: TableItemKey;
}

export interface PagedQueryOptions extends QueryOptions {
  /**
   * Required, unlike `QueryOptions.limit`. A page read with no limit is a
   * drain, and a drain is `queryGsi`'s job -- this method exists to stop
   * early and say where to continue. Narrowing the inherited optional to
   * required is legal and is what makes "forgot the limit" a compile error
   * instead of a 7,156-row read.
   */
  limit: number;
  startKey?: TableItemKey;
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
  /**
   * One page of a GSI partition, resumable. The opposite contract to
   * `queryGsi`, which drains: this ALWAYS pages -- it fills up to the
   * required `limit` and reports where to continue, and there is no calling
   * convention that makes it read a whole partition. Use it when a caller
   * pages a partition across HTTP requests; use `queryGsi` when a truncated
   * answer would be a wrong answer.
   */
  queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: PagedQueryOptions,
  ): Promise<QueryPage>;
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
      const attributeNames: Record<string, string> = hasSkPrefix
        ? { "#pk": pkAttribute, "#sk": skAttribute }
        : { "#pk": pkAttribute };
      const projectionExpression = DynamoTableClient.buildProjection(
        options.projection,
        attributeNames,
      );
      const result = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: indexName,
          KeyConditionExpression: hasSkPrefix
            ? `#pk = :pk AND begins_with(#sk, :skPrefix)`
            : `#pk = :pk`,
          ExpressionAttributeNames: attributeNames,
          ExpressionAttributeValues: hasSkPrefix
            ? { ":pk": partitionKey, ":skPrefix": options.skPrefix }
            : { ":pk": partitionKey },
          Limit: remainingLimit,
          ScanIndexForward: options.scanForward ?? true,
          // A GSI is eventually consistent by definition; asking for a
          // consistent read there is an error, so the flag is base-table only.
          ConsistentRead: indexName === undefined ? options.consistentRead : undefined,
          ExclusiveStartKey: exclusiveStartKey,
          ...(projectionExpression !== undefined
            ? { ProjectionExpression: projectionExpression }
            : {}),
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

  /**
   * Placeholders, never raw attribute names: `status`, `name`, `size` and a
   * hundred others are DynamoDB reserved words, and a raw name in a
   * ProjectionExpression is a ValidationException at runtime that no unit
   * test over the in-memory adapter would catch.
   *
   * NOT pure, despite the `build` in the name: it WRITES its placeholders
   * into the `attributeNames` map it is handed, because those placeholders
   * and the expression that references them have to reach the same command.
   * Callers must pass the very map they are about to send.
   */
  private static buildProjection(
    projection: readonly string[] | undefined,
    attributeNames: Record<string, string>,
  ): string | undefined {
    if (projection === undefined || projection.length === 0) return undefined;
    return projection
      .map((attributeName, attributeIndex) => {
        const placeholder = `#p${attributeIndex}`;
        attributeNames[placeholder] = attributeName;
        return placeholder;
      })
      .join(", ");
  }

  /**
   * One page of a GSI partition. The opposite contract to `queryGsi`/`query`
   * (via `runQuery`), which drain: this stops the moment `limit` items have
   * been collected, or the partition runs out first, and reports the key to
   * resume from. A caller paging a partition across HTTP requests needs
   * exactly that -- a drained answer would mean re-reading the whole
   * partition on every request.
   */
  async queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: PagedQueryOptions,
  ): Promise<QueryPage> {
    // Both adapters, identically: DynamoDB's Query rejects Limit < 1 with a
    // ValidationException, and the in-memory adapter answered an empty page
    // with no cursor -- reporting a partition exhausted that is not. A caller
    // computing a page size (`pageSize - alreadyCollected`) can legitimately
    // reach 0 and must stop looping rather than ask for nothing.
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError(`queryGsiPage needs a positive integer limit, got ${options.limit}`);
    }
    const pkAttribute = `${indexName}PK`;
    const skAttribute = `${indexName}SK`;
    const hasSkPrefix = options.skPrefix !== undefined;
    const collectedItems: TableItem[] = [];
    let exclusiveStartKey: TableItemKey | undefined = options.startKey;

    do {
      const remainingLimit = options.limit - collectedItems.length;
      const attributeNames: Record<string, string> = { "#pk": pkAttribute };
      if (hasSkPrefix) attributeNames["#sk"] = skAttribute;
      const projectionExpression = DynamoTableClient.buildProjection(
        options.projection,
        attributeNames,
      );
      const result = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: indexName,
          KeyConditionExpression: hasSkPrefix ? `#pk = :pk AND begins_with(#sk, :skPrefix)` : `#pk = :pk`,
          ExpressionAttributeNames: attributeNames,
          ExpressionAttributeValues: hasSkPrefix
            ? { ":pk": partitionKey, ":skPrefix": options.skPrefix }
            : { ":pk": partitionKey },
          Limit: remainingLimit,
          ScanIndexForward: options.scanForward ?? true,
          ExclusiveStartKey: exclusiveStartKey,
          ...(projectionExpression !== undefined
            ? { ProjectionExpression: projectionExpression }
            : {}),
        }),
      );
      collectedItems.push(...((result.Items ?? []) as TableItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
      // Unlike runQuery this does NOT keep going once the limit is met: the
      // caller is paging, and the unread remainder is what nextStartKey is
      // for. DynamoDB's own Limit means collectedItems can never overshoot,
      // so nothing is ever sliced off behind its own cursor.
    } while (exclusiveStartKey !== undefined && collectedItems.length < options.limit);

    return {
      items: collectedItems,
      ...(exclusiveStartKey !== undefined ? { nextStartKey: exclusiveStartKey } : {}),
    };
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

  async queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: PagedQueryOptions,
  ): Promise<QueryPage> {
    // Both adapters, identically: DynamoDB's Query rejects Limit < 1 with a
    // ValidationException, and the in-memory adapter answered an empty page
    // with no cursor -- reporting a partition exhausted that is not. A caller
    // computing a page size (`pageSize - alreadyCollected`) can legitimately
    // reach 0 and must stop looping rather than ask for nothing.
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError(`queryGsiPage needs a positive integer limit, got ${options.limit}`);
    }
    const pkAttribute = `${indexName}PK` as const;
    const skAttribute = `${indexName}SK` as const;
    // Ordered exactly as queryGsi would, and NOT limited yet: the cursor is a
    // position in this order, so slicing before finding it would lose it. Read
    // ascending always and reverse afterwards, so the total re-sort below runs
    // on one known direction.
    const orderedItems = this.filterAndSort(
      (item) => item[pkAttribute] === partitionKey,
      (item) => String(item[skAttribute] ?? ""),
      { ...options, limit: undefined, projection: undefined, scanForward: true },
    );
    orderedItems.sort((leftItem, rightItem) =>
      compareByteOrder(indexPositionOf(leftItem, skAttribute), indexPositionOf(rightItem, skAttribute)),
    );
    if (options.scanForward === false) orderedItems.reverse();

    // Resume by POSITION, not by identity. DynamoDB's ExclusiveStartKey does not
    // require the cursor row to still exist, and on a GSI1 partition keyed by
    // caseStatus a row leaving between two pages is the ordinary case. Matching
    // on PK/SK and letting findIndex's -1 fall through to 0 rewound the page to
    // the start of the partition and re-served rows the caller already had.
    const cursorPosition =
      options.startKey === undefined ? undefined : indexPositionOf(options.startKey, skAttribute);
    const firstUnreadIndex =
      cursorPosition === undefined
        ? 0
        : orderedItems.findIndex((item) => {
            const comparison = compareByteOrder(indexPositionOf(item, skAttribute), cursorPosition);
            return options.scanForward === false ? comparison < 0 : comparison > 0;
          });
    // -1 here means every remaining row is at or before the cursor: the
    // partition is exhausted, which is the opposite of where the old `+ 1` sent
    // it.
    const resumeIndex = firstUnreadIndex === -1 ? orderedItems.length : firstUnreadIndex;
    const pageItems = orderedItems.slice(resumeIndex, resumeIndex + options.limit);
    const lastItem = pageItems[pageItems.length - 1];
    const hasMore = resumeIndex + pageItems.length < orderedItems.length;

    return {
      items: pageItems.map((item) => projectItem(item, options.projection)),
      // The same shape DynamoDB hands back off a GSI query: the base-table key
      // AND the index key. Not cosmetic -- resuming by position (see above)
      // reads the index sort key straight off the cursor.
      ...(hasMore && lastItem !== undefined
        ? {
            nextStartKey: {
              PK: lastItem.PK,
              SK: lastItem.SK,
              [pkAttribute]: lastItem[pkAttribute],
              [skAttribute]: lastItem[skAttribute],
            },
          }
        : {}),
    };
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
    // compareByteOrder, not localeCompare: this orders every in-memory read
    // the suite makes, and an ICU collation orders `#` before `_` the opposite
    // way round from the byte order DynamoDB sorts by. See compareByteOrder.
    matches.sort((leftItem, rightItem) =>
      compareByteOrder(sortKeyOf(leftItem), sortKeyOf(rightItem)),
    );
    if (options.scanForward === false) matches.reverse();
    if (options.limit !== undefined) matches = matches.slice(0, options.limit);
    return matches.map((item) => projectItem(structuredClone(item), options.projection));
  }
}

/**
 * Compares two keys the way DynamoDB sorts them: by byte order.
 *
 * NOT `localeCompare`. That is an ICU linguistic collation and it disagrees
 * with byte order on four of five probed pairs, including shapes this repo
 * builds keys from every day -- most sharply `#` against `_`, where ICU orders
 * `TENANT#rgs#CASE#a` and `TENANT#rgs#CASE_REF#a` OPPOSITE to DynamoDB (byte 35
 * against byte 95), and both infixes are real in domain/crm/keys.ts. It also
 * ignores U+0000 entirely, and a sort key that is a prefix of another comes out
 * the wrong way round. A double that orders reads by a rule production does not
 * use is the works-in-tests / fails-in-production seam this module exists to
 * close.
 *
 * Relational `<`/`>` on a string compares by UTF-16 code unit, which matches
 * UTF-8 byte order across the ASCII key space in use here. The two diverge
 * above the BMP, which no key in this repo reaches.
 */
function compareByteOrder(leftKey: string, rightKey: string): number {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * A row's total position in a GSI partition: the index sort key first, then the
 * base-table key, which is unique. A cursor is a position in this order, so the
 * order has to be total -- two rows sharing a GSI sort key would otherwise swap
 * between two reads and be served twice, or skipped. Joined on NUL, which sorts
 * below every printable character IN BYTE ORDER, so a sort key that is a prefix
 * of another cannot borrow the next field's ordering.
 *
 * That property holds under `compareByteOrder` and did NOT hold under the
 * `localeCompare` that was here first: ICU collation treats U+0000 as
 * completely ignorable, so it compared the three fields as if plain-
 * concatenated and could return 0 for two distinct rows -- the exact totality
 * the separator exists to guarantee. Compare positions only with
 * `compareByteOrder`.
 */
function indexPositionOf(
  itemOrKey: Record<string, unknown>,
  indexSortKeyAttribute: string,
): string {
  const indexSortKey = String(itemOrKey[indexSortKeyAttribute] ?? "");
  const basePartitionKey = String(itemOrKey["PK"] ?? "");
  const baseSortKey = String(itemOrKey["SK"] ?? "");
  return `${indexSortKey}\u0000${basePartitionKey}\u0000${baseSortKey}`;
}

/**
 * The in-memory stand-in for ProjectionExpression. An attribute the item does
 * not have is simply absent from the result, exactly as DynamoDB returns it --
 * never present-and-undefined, which would read back as a null column.
 */
function projectItem(item: TableItem, projection: readonly string[] | undefined): TableItem {
  if (projection === undefined || projection.length === 0) return item;
  const projected: Record<string, unknown> = {};
  for (const attributeName of projection) {
    if (attributeName in item) projected[attributeName] = item[attributeName];
  }
  return projected as TableItem;
}
