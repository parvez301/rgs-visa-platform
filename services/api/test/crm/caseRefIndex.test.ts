import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeCaseRefReservation,
  readCaseRefReservation,
  reserveCaseRef,
} from "../../src/domain/crm/caseRefIndex";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";

afterEach(closeTestContexts);

const TENANT_ID = "rgs";
const NOW_ISO = "2026-07-23T10:00:00.000Z";

describe("caseRefIndex", () => {
  let context: TestContext;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await context.sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  beforeEach(async () => {
    context = await buildTestContext({ seedStatusEmailTemplates: false });
  });

  it("reports nothing for a ref nothing has reserved", async () => {
    expect(await readCaseRefReservation(context, TENANT_ID, "31376")).toBeUndefined();
  });

  it("reserves, reads back unfinished, then completes", async () => {
    const reserved = await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(reserved).toEqual({
      tenantId: TENANT_ID,
      caseRef: "31376",
      caseId: "case_1",
      reservedAt: NOW_ISO,
    });

    // "Reserved" and "imported" must stay distinguishable, or a run that died
    // between them is indistinguishable from one that finished and the ref
    // gets a second case.
    const unfinished = await readCaseRefReservation(context, TENANT_ID, "31376");
    expect(unfinished).toEqual(reserved);
    expect(unfinished!.completedAt).toBeUndefined();

    const completed = await completeCaseRefReservation(context, TENANT_ID, unfinished!);
    expect(completed.completedAt).toBe(context.now().toISOString());
    expect(await readCaseRefReservation(context, TENANT_ID, "31376")).toEqual(completed);

    expect(await scalar<number>("select count(*)::int as value from crm_case_ref_reservations")).toBe(1);
  });

  it("upserts on (tenant, ref): completing never adds a second row", async () => {
    const reserved = await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    await completeCaseRefReservation(context, TENANT_ID, reserved);
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");

    expect(await scalar<number>("select count(*)::int as value from crm_case_ref_reservations")).toBe(1);
  });

  it("keeps one tenant's reservations out of another's", async () => {
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(await readCaseRefReservation(context, "other-tenant", "31376")).toBeUndefined();
  });

  it("is separate from REF claims", async () => {
    await reserveCaseRef(context, TENANT_ID, "31376", "case_1");
    expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(0);
  });
});
