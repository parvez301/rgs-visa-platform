import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { createCase } from "../../src/domain/crm/cases";
import { memoryPartitionKey } from "../../src/domain/crm/keys";
import {
  forgetMemory,
  getMemoryOrUndefined,
  memoryRowExists,
  memoryScope,
  recallMemories,
  rememberMemory,
} from "../../src/domain/crm/memory";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const ALICE = "alice@rgs.local";
const BOB = "bob@rgs.local";
const NOW_ISO = "2026-07-23T10:00:00.000Z";

describe("CRM memory with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  async function dynamoMemoryRowCount(scope: string): Promise<number> {
    const items = await baseContext.table.query(memoryPartitionKey(TENANT_ID, scope), {});
    return items.length;
  }

  async function seedCase() {
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels 90001", partnerType: "AGENCY" },
      ALICE,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
    return createCase(
      context,
      TENANT_ID,
      {
        caseRef: "90001",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ALICE,
    );
  }

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext({ seedStatusEmailTemplates: false });
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  it("remembers an ORG memory in Postgres, recalls it, and leaves Dynamo empty", async () => {
    const remembered = await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "refund-policy", text: "refunds within 7 days" },
      "human",
      ALICE,
    );
    expect(remembered.createdAt).toBe(NOW_ISO);
    expect(remembered.createdByEmail).toBe(ALICE);
    expect(remembered.sourceCaseId).toBeUndefined();

    expect(await scalar<number>("select count(*)::int as value from crm_memories")).toBe(1);
    expect(await dynamoMemoryRowCount("ORG")).toBe(0);

    const listing = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
    expect(listing.unreadableMemoryKeys).toEqual([]);
    expect(listing.memories).toEqual([remembered]);
    expect(await getMemoryOrUndefined(context, TENANT_ID, "ORG", "refund-policy")).toEqual(
      remembered,
    );
    expect(await memoryRowExists(context, TENANT_ID, "ORG", "refund-policy")).toBe(true);
  });

  it("re-remembering the same (scope, memoryKey) overwrites in place", async () => {
    const scope = memoryScope("ORG");
    await rememberMemory(context, TENANT_ID, { scope, memoryKey: "k", text: "one" }, "human", ALICE);
    await rememberMemory(context, TENANT_ID, { scope, memoryKey: "k", text: "two" }, "human", ALICE);

    expect(await scalar<number>("select count(*)::int as value from crm_memories")).toBe(1);
    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories.map((memory) => memory.text)).toEqual(["two"]);
  });

  it("recalls several scopes in memoryKey order, deduplicated, honouring the limit", async () => {
    const orgScope = memoryScope("ORG");
    const userScope = memoryScope("USER", ALICE);
    for (const memoryKey of ["b", "c", "a"]) {
      await rememberMemory(context, TENANT_ID, { scope: orgScope, memoryKey, text: memoryKey }, "human", ALICE);
    }
    await rememberMemory(context, TENANT_ID, { scope: userScope, memoryKey: "mine", text: "mine" }, "human", ALICE);
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", BOB), memoryKey: "bobs", text: "bobs" },
      "human",
      BOB,
    );

    const all = await recallMemories(context, TENANT_ID, [orgScope, userScope, orgScope]);
    expect(all.memories.map((memory) => memory.memoryKey)).toEqual(["a", "b", "c", "mine"]);

    const limited = await recallMemories(context, TENANT_ID, [orgScope], 2);
    expect(limited.memories.map((memory) => memory.memoryKey)).toEqual(["a", "b"]);
  });

  it("forgets a memory, and forgetting a missing key is a no-op", async () => {
    const scope = memoryScope("ORG");
    await rememberMemory(context, TENANT_ID, { scope, memoryKey: "k", text: "x" }, "human", ALICE);

    await forgetMemory(context, TENANT_ID, scope, "k", ALICE);
    expect(await scalar<number>("select count(*)::int as value from crm_memories")).toBe(0);
    expect(await memoryRowExists(context, TENANT_ID, scope, "k")).toBe(false);
    expect(await getMemoryOrUndefined(context, TENANT_ID, scope, "k")).toBeUndefined();

    await expect(forgetMemory(context, TENANT_ID, scope, "k", ALICE)).resolves.toBeUndefined();
  });

  it("still refuses an agent memory without sourceCaseId, writing nothing", async () => {
    await expect(
      rememberMemory(
        context,
        TENANT_ID,
        { scope: memoryScope("ORG"), memoryKey: "k", text: "x" },
        "agent",
        ALICE,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await scalar<number>("select count(*)::int as value from crm_memories")).toBe(0);
  });

  it("stores an agent memory citing a real Postgres case, and refuses an unknown case", async () => {
    const seededCase = await seedCase();
    const remembered = await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("ORG"),
        memoryKey: "slots",
        text: "prefers mornings",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );
    expect(remembered.createdBy).toBe("agent");
    expect(remembered.sourceCaseId).toBe(seededCase.caseId);
    expect(await getMemoryOrUndefined(context, TENANT_ID, "ORG", "slots")).toEqual(remembered);

    await expect(
      rememberMemory(
        context,
        TENANT_ID,
        { scope: memoryScope("ORG"), memoryKey: "ghost", text: "x", sourceCaseId: "case_missing" },
        "agent",
        ALICE,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await scalar<number>("select count(*)::int as value from crm_memories")).toBe(1);
  });

  it("keeps USER scope owner-only", async () => {
    await expect(
      rememberMemory(
        context,
        TENANT_ID,
        { scope: memoryScope("USER", BOB), memoryKey: "k", text: "x" },
        "human",
        ALICE,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(forgetMemory(context, TENANT_ID, memoryScope("USER", BOB), "k", ALICE)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("names a row that will not parse in unreadableMemoryKeys, and can still delete it", async () => {
    await rememberMemory(context, TENANT_ID, { scope: "ORG", memoryKey: "good", text: "ok" }, "human", ALICE);
    // An agent row with no source case: the schema refinement refuses it on read.
    await sql.query(
      `insert into crm_memories (tenant_id, scope, memory_key, text, created_by, created_at)
       values ($1, 'ORG', 'bad', 'orphan', 'agent', $2::timestamptz)`,
      [TENANT_ID, NOW_ISO],
    );

    const listing = await recallMemories(context, TENANT_ID, ["ORG"]);
    expect(listing.memories.map((memory) => memory.memoryKey)).toEqual(["good"]);
    expect(listing.unreadableMemoryKeys).toEqual(["bad"]);

    expect(await memoryRowExists(context, TENANT_ID, "ORG", "bad")).toBe(true);
    await forgetMemory(context, TENANT_ID, "ORG", "bad", ALICE);
    expect(await memoryRowExists(context, TENANT_ID, "ORG", "bad")).toBe(false);
  });

  it("isolates tenants", async () => {
    await rememberMemory(context, TENANT_ID, { scope: "ORG", memoryKey: "k", text: "x" }, "human", ALICE);
    const other = await recallMemories(context, "other", ["ORG"]);
    expect(other.memories).toEqual([]);
  });
});
