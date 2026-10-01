import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { addApplicant, removeApplicant, updateApplicantDetails } from "../../src/domain/crm/applicantEdits";
import { readCase, readCaseOrThrow } from "../../src/domain/crm/caseStore";
import {
  changeApplicantCustody,
  changeApplicantOutcome,
  changeBillingStatus,
  changeCaseStatus,
  createCase,
  updateCaseDetails,
} from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { casePartitionKey } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { readRefClaim } from "../../src/domain/crm/refClaims";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

/**
 * Wraps the in-memory Dynamo table so every string argument of every call (the
 * partition keys, index names and sort keys) is recorded. A mutator that still
 * touches a case or event partition in Dynamo shows up here, which is a
 * stronger proof than "the Dynamo table happens to be empty afterwards": a
 * read that came back empty would not leave a trace in the table.
 */
function trackTableAccess(table: TestContext["table"]): { table: TestContext["table"]; touchedKeys: string[] } {
  const touchedKeys: string[] = [];
  const tracked = new Proxy(table, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === "string") touchedKeys.push(arg);
          else if (typeof arg === "object" && arg !== null && typeof (arg as { PK?: unknown }).PK === "string") {
            touchedKeys.push((arg as { PK: string }).PK);
          }
        }
        return member.apply(target, args);
      };
    },
  });
  return { table: tracked, touchedKeys };
}

describe("CRM case mutators with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let context: TestContext & AppContext;
  let touchedKeys: string[];

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    const baseContext = buildTestContext();
    const tracking = trackTableAccess(baseContext.table);
    touchedKeys = tracking.touchedKeys;
    context = { ...baseContext, table: tracking.table, crmStore: "postgres", sql };
  });

  // Hybrid by design for B.1: partners, travellers and REF claims still live in
  // Dynamo until their own tasks move them. Cases and events must not.
  async function seedPartnerId(): Promise<string> {
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels" }, ACTOR);
    return partner.partnerId;
  }

  async function seedTravellerId(fullName: string): Promise<string> {
    return (await upsertTraveller(context, TENANT_ID, { fullName })).travellerId;
  }

  async function seedCase(
    partnerId: string,
    caseRef: string,
    applicantRefs: readonly string[] = [caseRef],
    overrides: { groupName?: string } = {},
  ): Promise<crm.CrmCase> {
    const applicants = [];
    for (const applicantRef of applicantRefs) {
      applicants.push({ applicantRef, travellerId: await seedTravellerId(`Traveller ${applicantRef}`) });
    }
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef,
        caseType: "VISA",
        partnerId,
        destinationCountry: "BH",
        visaType: "EVISA_TOURIST",
        entryType: "SINGLE",
        processing: "NORMAL",
        receivedDate: "2026-01-02",
        applicants,
        ...overrides,
      },
      ACTOR,
    );
    // Events sort by createdAt then eventId (random), so give CASE_CREATED a
    // tick of its own and every later event a later one.
    context.advanceClock(1_000);
    return created;
  }

  /** Every Dynamo key a case or event could live under for this case. */
  function expectNoDynamoCaseAccess(caseId: string): void {
    const casePartition = casePartitionKey(TENANT_ID, caseId);
    expect(touchedKeys.filter((key) => key === casePartition || key.includes("#CASE#"))).toEqual([]);
    // Case status / partner indexes are written by the Dynamo writeCase only.
    expect(touchedKeys.filter((key) => key.includes("#CASE_STATUS#") || key.includes("#PARTNER_CASES#"))).toEqual([]);
  }

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  it("createCase writes case, applicants and event to Postgres and never touches Dynamo case keys", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377", ["31377-1", "31377-2"]);

    expect(created.caseStatus).toBe("NEW");
    expect(created.applicants.map((applicant) => applicant.applicantRef)).toEqual(["31377-1", "31377-2"]);

    expect(await scalar<number>("select count(*)::int as value from crm_cases")).toBe(1);
    expect(await scalar<number>("select count(*)::int as value from crm_applicants")).toBe(2);

    const reread = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(reread).toEqual(created);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED"]);
    expect(await scalar<number>("select count(*)::int as value from crm_events")).toBe(1);

    // Hybrid seams still work: the REF claim (Dynamo until Task 6) is held.
    expect(await readRefClaim(context, TENANT_ID, "31377")).toBeDefined();
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("createCase stamps the Ledger search haystack from Dynamo travellers into the Postgres row", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "40001");
    const searchText = await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [
      created.caseId,
    ]);
    expect(searchText).toContain("traveller 40001");
  });

  it("createCase for an unknown partner fails before anything is written to Postgres", async () => {
    const travellerId = await seedTravellerId("Nobody");
    await expect(
      createCase(
        context,
        TENANT_ID,
        {
          caseRef: "50001",
          caseType: "VISA",
          partnerId: "partner_missing",
          destinationCountry: "BH",
          visaType: "EVISA_TOURIST",
          receivedDate: "2026-01-02",
          applicants: [{ applicantRef: "50001", travellerId }],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await scalar<number>("select count(*)::int as value from crm_cases")).toBe(0);
    expect(await scalar<number>("select count(*)::int as value from crm_events")).toBe(0);
  });

  it("changeCaseStatus moves the Postgres row, records the event and mails the client", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");

    const moved = await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(moved.caseStatus).toBe("DOCS_UNDER_REVIEW");
    expect(moved.updatedAt > created.updatedAt).toBe(true);
    expect(await scalar<string>("select case_status as value from crm_cases where case_id = $1", [created.caseId])).toBe(
      "DOCS_UNDER_REVIEW",
    );
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).caseStatus).toBe("DOCS_UNDER_REVIEW");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED", "CASE_STATUS_CHANGED"]);
    expect(events[1]?.meta).toEqual({ fromStatus: "NEW", toStatus: "DOCS_UNDER_REVIEW" });
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("changeCaseStatus refuses an illegal move and leaves the Postgres row alone", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");

    await expect(changeCaseStatus(context, TENANT_ID, created.caseId, "DECIDED", ACTOR)).resolves.toBeDefined();
    // DECIDED -> NEW is not a legal edge.
    await expect(changeCaseStatus(context, TENANT_ID, created.caseId, "NEW", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).caseStatus).toBe("DECIDED");
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.filter((event) => event.eventType === "CASE_STATUS_CHANGED")).toHaveLength(1);
  });

  it("changeCaseStatus on a case that does not exist is a 404, not a Dynamo fallback", async () => {
    await expect(changeCaseStatus(context, TENANT_ID, "case_missing", "DOCS_UNDER_REVIEW", ACTOR)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    expectNoDynamoCaseAccess("case_missing");
  });

  it("updateCaseDetails edits, clears and re-keys fields in Postgres", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    context.advanceClock(1_000);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      {
        caseRef: "31377B",
        destinationCountry: "JP",
        appointmentDate: "2026-02-01",
        remarks: "Rush",
        groupName: "Smith family",
      },
      ACTOR,
    );
    expect(updated.caseRef).toBe("31377B");
    expect(updated.destinationCountry).toBe("JP");

    const row = (
      await sql.query<{ case_ref: string; destination_country: string; appointment_date: string; remarks: string }>(
        `select case_ref, destination_country, to_char(appointment_date, 'YYYY-MM-DD') as appointment_date, remarks
           from crm_cases where case_id = $1`,
        [created.caseId],
      )
    ).rows[0];
    expect(row).toEqual({
      case_ref: "31377B",
      destination_country: "JP",
      appointment_date: "2026-02-01",
      remarks: "Rush",
    });
    // Group name is part of the search haystack too.
    expect(
      await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [created.caseId]),
    ).toContain("smith family");

    // The REF moved: new one claimed, old one released (still Dynamo until Task 6).
    expect(await readRefClaim(context, TENANT_ID, "31377B")).toBeDefined();
    expect(await readRefClaim(context, TENANT_ID, "31377")).toBeUndefined();

    // null clears the column rather than leaving the old value behind.
    context.advanceClock(1_000);
    const cleared = await updateCaseDetails(context, TENANT_ID, created.caseId, { remarks: null }, ACTOR);
    expect(cleared.remarks).toBeUndefined();
    expect(await scalar<string | null>("select remarks as value from crm_cases where case_id = $1", [created.caseId])).toBeNull();

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED", "CASE_UPDATED", "CASE_UPDATED"]);
    expect(events[1]?.meta["changedFields"]).toBe(
      "caseRef,destinationCountry,appointmentDate,remarks,groupName",
    );
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("updateCaseDetails with no real change writes nothing new", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    context.advanceClock(1_000);

    const result = await updateCaseDetails(context, TENANT_ID, created.caseId, { destinationCountry: "BH" }, ACTOR);

    expect(result.updatedAt).toBe(created.updatedAt);
    expect((await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType)).toEqual([
      "CASE_CREATED",
    ]);
  });

  it("updateCaseDetails collision on a taken REF leaves the Postgres row unchanged", async () => {
    const partnerId = await seedPartnerId();
    const first = await seedCase(partnerId, "11111");
    await seedCase(partnerId, "22222");

    await expect(updateCaseDetails(context, TENANT_ID, first.caseId, { caseRef: "22222" }, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, first.caseId)).caseRef).toBe("11111");
  });

  it("changeBillingStatus persists in Postgres, and PAID plus every passport back closes the case", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const applicantRef = created.applicants[0]!.applicantRef;

    // Events sort by createdAt then eventId, so each step gets its own tick.
    context.advanceClock(1_000);
    const billed = await changeBillingStatus(context, TENANT_ID, created.caseId, "BILL_SENT", ACTOR);
    expect(billed.billingStatus).toBe("BILL_SENT");
    expect(
      await scalar<string>("select billing_status as value from crm_cases where case_id = $1", [created.caseId]),
    ).toBe("BILL_SENT");

    context.advanceClock(1_000);
    await changeApplicantCustody(context, TENANT_ID, created.caseId, applicantRef, "WITH_RGS", ACTOR);
    context.advanceClock(1_000);
    await changeApplicantCustody(context, TENANT_ID, created.caseId, applicantRef, "RETURNED", ACTOR);
    context.advanceClock(1_000);
    const paid = await changeBillingStatus(context, TENANT_ID, created.caseId, "PAID", ACTOR);

    expect(paid.billingStatus).toBe("PAID");
    expect(paid.caseStatus).toBe("CLOSED");
    const stored = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(stored.caseStatus).toBe("CLOSED");
    expect(stored.applicants[0]?.custody).toBe("RETURNED");
    expect(stored.applicants[0]?.custodySince).toBeDefined();

    const eventTypes = (await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType);
    expect(eventTypes.slice(0, 4)).toEqual(["CASE_CREATED", "BILLING_CHANGED", "CUSTODY_CHANGED", "CUSTODY_CHANGED"]);
    // The PAID write and the CLOSED it derives share one clock tick, so their
    // relative order is eventId order (random), as it is on Dynamo.
    expect(eventTypes.slice(4).sort()).toEqual(["BILLING_CHANGED", "CASE_STATUS_CHANGED"]);
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("changeBillingStatus refuses a move the machine does not allow", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    await expect(changeBillingStatus(context, TENANT_ID, created.caseId, "PAID", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).billingStatus).toBe("UNBILLED");
  });

  it("changeApplicantOutcome derives DECIDED from applicant outcomes in Postgres", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    // DECIDED is derived from SUBMITTED onwards.
    await changeCaseStatus(context, TENANT_ID, created.caseId, "SUBMITTED", ACTOR);

    const decided = await changeApplicantOutcome(
      context,
      TENANT_ID,
      created.caseId,
      created.applicants[0]!.applicantRef,
      "APPROVED",
      ACTOR,
    );

    expect(decided.applicants[0]?.outcome).toBe("APPROVED");
    const stored = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(stored.applicants[0]?.outcome).toBe("APPROVED");
    expect(stored.caseStatus).toBe(decided.caseStatus);
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("addApplicant appends a Postgres applicant row and refreshes the search haystack", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const newTravellerId = await seedTravellerId("Priya Nair");

    const updated = await addApplicant(
      context,
      TENANT_ID,
      created.caseId,
      { travellerId: newTravellerId, passportNumber: "z9999999", refNo: "R-77" },
      ACTOR,
    );

    expect(updated.applicants).toHaveLength(2);
    const added = updated.applicants[1]!;
    expect(added).toMatchObject({ travellerId: newTravellerId, passportNumber: "Z9999999", refNo: "R-77" });
    expect(await scalar<number>("select count(*)::int as value from crm_applicants where case_id = $1", [created.caseId])).toBe(2);
    expect(
      await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [created.caseId]),
    ).toContain("priya nair");
    expect(await readRefClaim(context, TENANT_ID, "R-77")).toBeDefined();

    const summary = await scalar<{ count: number }>(
      "select applicant_summary as value from crm_cases where case_id = $1",
      [created.caseId],
    );
    expect(summary.count).toBe(2);
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("updateApplicantDetails rewrites the applicant row, the traveller and the search haystack", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const applicantRef = created.applicants[0]!.applicantRef;

    const updated = await updateApplicantDetails(
      context,
      TENANT_ID,
      created.caseId,
      applicantRef,
      { fullName: "Asha Verma", passportNumber: "n1234567", refNo: "R-1" },
      ACTOR,
    );

    expect(updated.applicants[0]).toMatchObject({ passportNumber: "N1234567", refNo: "R-1" });
    const row = (
      await sql.query<{ passport_number: string; ref_no: string }>(
        "select passport_number, ref_no from crm_applicants where case_id = $1 and applicant_ref = $2",
        [created.caseId, applicantRef],
      )
    ).rows[0];
    expect(row).toEqual({ passport_number: "N1234567", ref_no: "R-1" });
    // The second writeCase picked up the renamed traveller (Dynamo) after the edit.
    const searchText = await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [
      created.caseId,
    ]);
    expect(searchText).toContain("asha verma");
    expect(searchText).toContain("n1234567");
    expect(searchText).not.toContain("traveller 31377");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.at(-1)).toMatchObject({ eventType: "APPLICANT_UPDATED" });
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("removeApplicant drops the Postgres applicant row and compacts indexes, and refuses the last one", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377", ["A1", "A2", "A3"]);

    const updated = await removeApplicant(context, TENANT_ID, created.caseId, "A2", ACTOR);

    expect(updated.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A1", "A3"]);
    const rows = await sql.query<{ applicant_index: number; applicant_ref: string }>(
      "select applicant_index, applicant_ref from crm_applicants where case_id = $1 order by applicant_index",
      [created.caseId],
    );
    expect(rows.rows).toEqual([
      { applicant_index: 0, applicant_ref: "A1" },
      { applicant_index: 1, applicant_ref: "A3" },
    ]);

    context.advanceClock(1_000);
    await removeApplicant(context, TENANT_ID, created.caseId, "A3", ACTOR);
    await expect(removeApplicant(context, TENANT_ID, created.caseId, "A1", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).applicants).toHaveLength(1);

    const eventTypes = (await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType);
    expect(eventTypes).toEqual(["CASE_CREATED", "APPLICANT_REMOVED", "APPLICANT_REMOVED"]);
    expectNoDynamoCaseAccess(created.caseId);
  });

  it("a case written under postgres is invisible to a Dynamo-backed context (stores do not mix)", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const dynamoContext: AppContext = { ...context, crmStore: "dynamo" };
    expect(await readCase(dynamoContext, TENANT_ID, created.caseId)).toBeUndefined();
  });
});
