import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import {
  changeCaseStatus,
  countCasesByField,
  createCase,
  listCaseRefsByStatus,
  listCasesByPartner,
  listCasesByStatus,
} from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

/** A table whose every call throws: proves a Postgres-backed read never reaches Dynamo. */
function forbidDynamo(table: TestContext["table"]): TestContext["table"] {
  return new Proxy(table, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return () => {
        throw new Error(`Dynamo table touched: ${String(property)}`);
      };
    },
  });
}

describe("CRM case lists / counts / refs with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let context: TestContext & AppContext;
  let baseContext: TestContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext();
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  async function seedPartnerId(name: string): Promise<string> {
    return (await createPartner(context, TENANT_ID, { canonicalName: name }, ACTOR)).partnerId;
  }

  async function seedCase(
    partnerId: string,
    caseRef: string,
    overrides: { destinationCountry?: string; receivedDate?: string } = {},
  ): Promise<crm.CrmCase> {
    const travellerId = (await upsertTraveller(context, TENANT_ID, { fullName: `Traveller ${caseRef}` })).travellerId;
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef,
        caseType: "VISA",
        partnerId,
        destinationCountry: overrides.destinationCountry ?? "BH",
        visaType: "EVISA_TOURIST",
        entryType: "SINGLE",
        processing: "NORMAL",
        receivedDate: overrides.receivedDate ?? "2026-01-02",
        applicants: [{ applicantRef: caseRef, travellerId }],
      },
      ACTOR,
    );
    context.advanceClock(1_000);
    return created;
  }

  /** From here on any Dynamo access is a failure. */
  function forbidDynamoFromNow(): void {
    context = { ...context, table: forbidDynamo(baseContext.table) };
  }

  it("listCasesByStatus returns the Postgres cases, newest update first, without touching Dynamo", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    const first = await seedCase(partnerId, "10001");
    const second = await seedCase(partnerId, "10002");
    const moved = await seedCase(partnerId, "10003");
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    forbidDynamoFromNow();

    const listing = await listCasesByStatus(context, TENANT_ID, "NEW");

    expect(listing.unreadableCaseIds).toEqual([]);
    expect(listing.cases.map((c) => c.caseId)).toEqual([second.caseId, first.caseId]);
    expect(listing.cases[0]).toEqual(second);
    const other = await listCasesByStatus(context, TENANT_ID, "DOCS_UNDER_REVIEW");
    expect(other.cases.map((c) => c.caseId)).toEqual([moved.caseId]);
  });

  it("listCasesByStatus honours the limit and names an unreadable (applicant-less) row", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    const a = await seedCase(partnerId, "10001");
    const b = await seedCase(partnerId, "10002");
    const broken = await seedCase(partnerId, "10003");
    await sql.query("delete from crm_applicants where case_id = $1", [broken.caseId]);
    forbidDynamoFromNow();

    const limited = await listCasesByStatus(context, TENANT_ID, "NEW", 2);
    expect(limited.cases.length + limited.unreadableCaseIds.length).toBe(2);

    const all = await listCasesByStatus(context, TENANT_ID, "NEW", 50);
    expect(all.unreadableCaseIds).toEqual([broken.caseId]);
    expect(all.cases.map((c) => c.caseId)).toEqual([b.caseId, a.caseId]);
  });

  it("listCasesByStatus is tenant scoped", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    await seedCase(partnerId, "10001");
    expect((await listCasesByStatus(context, "other-tenant", "NEW")).cases).toEqual([]);
  });

  it("listCasesByPartner returns that partner's cases, latest received first", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const other = await seedPartnerId("Other Travels");
    const older = await seedCase(ozzy, "10001", { receivedDate: "2026-01-02" });
    const newer = await seedCase(ozzy, "10002", { receivedDate: "2026-03-05" });
    await seedCase(other, "20001");
    forbidDynamoFromNow();

    const listing = await listCasesByPartner(context, TENANT_ID, ozzy);
    expect(listing.cases.map((c) => c.caseId)).toEqual([newer.caseId, older.caseId]);

    const limited = await listCasesByPartner(context, TENANT_ID, ozzy, 1);
    expect(limited.cases.map((c) => c.caseId)).toEqual([newer.caseId]);
  });

  it("countCasesByField groups by every supported field and totals match", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const other = await seedPartnerId("Other Travels");
    await seedCase(ozzy, "10001", { destinationCountry: "BH" });
    await seedCase(ozzy, "10002", { destinationCountry: "JP" });
    const moved = await seedCase(other, "20001", { destinationCountry: "BH" });
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    forbidDynamoFromNow();

    expect(await countCasesByField(context, TENANT_ID, "caseStatus")).toEqual({
      counts: { NEW: 2, DOCS_UNDER_REVIEW: 1 },
      total: 3,
      uncountedCaseIds: [],
    });
    expect((await countCasesByField(context, TENANT_ID, "destinationCountry")).counts).toEqual({ BH: 2, JP: 1 });
    expect((await countCasesByField(context, TENANT_ID, "billingStatus")).counts).toEqual({ UNBILLED: 3 });
    expect((await countCasesByField(context, TENANT_ID, "partnerId")).counts).toEqual({ [ozzy]: 2, [other]: 1 });
    expect((await countCasesByField(context, "other-tenant", "caseStatus")).total).toBe(0);
  });

  it("countCasesByField names a case whose counted field is empty instead of counting it", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    await seedCase(ozzy, "10001");
    const blank = await seedCase(ozzy, "10002");
    await sql.query("update crm_cases set destination_country = '' where case_id = $1", [blank.caseId]);

    const counted = await countCasesByField(context, TENANT_ID, "destinationCountry");
    expect(counted).toEqual({ counts: { BH: 1 }, total: 1, uncountedCaseIds: [blank.caseId] });
  });

  it("listCaseRefsByStatus returns refs without reassembling cases, including applicant-less rows", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const a = await seedCase(ozzy, "10001");
    const b = await seedCase(ozzy, "10002");
    // A half-written case (no applicants) still has a ref the importer must know about.
    await sql.query("delete from crm_applicants where case_id = $1", [b.caseId]);
    const moved = await seedCase(ozzy, "10003");
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    forbidDynamoFromNow();

    const listed = await listCaseRefsByStatus(context, TENANT_ID, "NEW");
    expect(listed.unreadableCaseIds).toEqual([]);
    expect(listed.storedCaseRefs).toEqual([
      { caseRef: "10002", caseId: b.caseId },
      { caseRef: "10001", caseId: a.caseId },
    ]);

    const limited = await listCaseRefsByStatus(context, TENANT_ID, "NEW", 1);
    expect(limited.storedCaseRefs).toEqual([{ caseRef: "10002", caseId: b.caseId }]);
  });

  it("a Dynamo-backed context still answers from the GSIs", async () => {
    const dynamoContext: TestContext & AppContext = { ...baseContext, crmStore: "dynamo" };
    const partner = await createPartner(dynamoContext, TENANT_ID, { canonicalName: "Ozzy Travels" }, ACTOR);
    const traveller = await upsertTraveller(dynamoContext, TENANT_ID, { fullName: "Asha" });
    const created = await createCase(
      dynamoContext,
      TENANT_ID,
      {
        caseRef: "30001",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "BH",
        visaType: "EVISA_TOURIST",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: "30001", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    expect((await listCasesByStatus(dynamoContext, TENANT_ID, "NEW")).cases.map((c) => c.caseId)).toEqual([
      created.caseId,
    ]);
    expect(
      (await listCasesByPartner(dynamoContext, TENANT_ID, partner.partnerId)).cases.map((c) => c.caseId),
    ).toEqual([created.caseId]);
    expect((await countCasesByField(dynamoContext, TENANT_ID, "caseStatus")).counts).toEqual({ NEW: 1 });
    expect((await listCaseRefsByStatus(dynamoContext, TENANT_ID, "NEW")).storedCaseRefs).toEqual([
      { caseRef: "30001", caseId: created.caseId },
    ]);
    // ...and sees none of the Postgres-side cases.
    expect((await listCasesByStatus(context, TENANT_ID, "NEW")).cases).toEqual([]);
  });
});
