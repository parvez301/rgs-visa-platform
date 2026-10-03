import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyApprovedChange,
  discardProposal,
  getProposal,
  listPendingProposals,
  stageProposal,
  type ProposedChange,
} from "../../src/agent/approval";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { createCase } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { SqlClient } from "../../src/lib/sql";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";
const NOW_ISO = "2026-07-23T10:00:00.000Z";

function proposal(proposalId: string, overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    proposalId,
    toolName: "set_billing",
    input: { caseId: "case_1", billingStatus: "BILL_SENT", extra: { nested: [1, 2] } },
    summary: [{ field: "billingStatus", from: "UNBILLED", to: "BILL_SENT" }],
    caseId: "case_1",
    proposedBy: ACTOR,
    proposedAt: NOW_ISO,
    status: "PENDING",
    ...overrides,
  };
}

describe("agent proposals", () => {
  let sql: SqlClient;
  let context: SqlTestContext;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  async function seedCase() {
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels 80001", partnerType: "AGENCY" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
    return createCase(
      context,
      TENANT_ID,
      {
        caseRef: "80001",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
  }

  beforeEach(async () => {
    context = await buildSqlTestContext({ seedStatusEmailTemplates: false });
    sql = context.sql;
  });

  afterEach(closeSqlTestContexts);

  it("stages a PENDING proposal in Postgres with jsonb input/summary", async () => {
    const staged = await stageProposal(context, TENANT_ID, proposal("prop_1"));

    expect(await scalar<number>("select count(*)::int as value from crm_proposals")).toBe(1);
    expect(
      await scalar<string>(
        "select jsonb_typeof(input) || '/' || jsonb_typeof(summary) as value from crm_proposals",
      ),
    ).toBe("object/array");

    expect(await getProposal(context, TENANT_ID, "prop_1")).toEqual(staged);
  });

  it("returns undefined for an absent proposal and keeps tenants apart", async () => {
    await stageProposal(context, TENANT_ID, proposal("prop_1"));
    expect(await getProposal(context, TENANT_ID, "prop_missing")).toBeUndefined();
    expect(await getProposal(context, "other-tenant", "prop_1")).toBeUndefined();
  });

  it("lists only PENDING proposals, oldest first", async () => {
    await stageProposal(context, TENANT_ID, proposal("prop_b", { proposedAt: "2026-07-23T10:00:02.000Z" }));
    await stageProposal(context, TENANT_ID, proposal("prop_a", { proposedAt: "2026-07-23T10:00:01.000Z" }));
    await stageProposal(context, TENANT_ID, proposal("prop_c"));
    await discardProposal(context, TENANT_ID, "prop_c", ACTOR, "wrong case");

    const listing = await listPendingProposals(context, TENANT_ID);
    expect(listing.proposals.map((pending) => pending.proposalId)).toEqual(["prop_a", "prop_b"]);
    expect(listing.unreadableProposalIds).toEqual([]);
  });

  it("persists a discard in place with its reason, and refuses a second decision", async () => {
    await stageProposal(context, TENANT_ID, proposal("prop_1"));
    context.advanceClock(60_000);
    const discarded = await discardProposal(context, TENANT_ID, "prop_1", ACTOR, "wrong case");

    expect(discarded).toMatchObject({ status: "DISCARDED", decidedBy: ACTOR, discardReason: "wrong case" });
    expect(await scalar<number>("select count(*)::int as value from crm_proposals")).toBe(1);
    expect(await getProposal(context, TENANT_ID, "prop_1")).toEqual(discarded);
    expect((await listPendingProposals(context, TENANT_ID)).proposals).toEqual([]);

    await expect(
      discardProposal(context, TENANT_ID, "prop_1", ACTOR, "again"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists an approval in place, applies the domain change, and refuses a second approval", async () => {
    const seeded = await seedCase();
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposed = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposed);

    context.advanceClock(60_000);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const approved = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(approved).toMatchObject({ status: "APPROVED", decidedBy: ACTOR });
    expect(approved!.decidedAt).not.toBe(staged.proposedAt);
    expect(approved!.input).toEqual(staged.input);
    expect(await scalar<number>("select count(*)::int as value from crm_proposals")).toBe(1);
    expect((await listPendingProposals(context, TENANT_ID)).proposals).toEqual([]);

    await expect(
      applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("answers 404 when approving or discarding a proposal that does not exist", async () => {
    await expect(
      applyApprovedChange(context, TENANT_ID, "prop_missing", ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      discardProposal(context, TENANT_ID, "prop_missing", ACTOR, "why"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a blank decidedBy before anything is stored", async () => {
    await stageProposal(context, TENANT_ID, proposal("prop_1"));
    await expect(
      discardProposal(context, TENANT_ID, "prop_1", "", "why"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await getProposal(context, TENANT_ID, "prop_1"))!.status).toBe("PENDING");
  });

  it("names a row that no longer parses and still lists the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stageProposal(context, TENANT_ID, proposal("prop_1"));
      await sql.query(
        `insert into crm_proposals
           (tenant_id, proposal_id, status, tool_name, proposed_by, proposed_at, input, summary)
         values ($1, 'prop_bad', 'PENDING', 'set_billing', '', $2::timestamptz,
                 '{}'::jsonb, '[{"field": 1}]'::jsonb)`,
        [TENANT_ID, NOW_ISO],
      );

      const listing = await listPendingProposals(context, TENANT_ID);
      expect(listing.proposals.map((pending) => pending.proposalId)).toEqual(["prop_1"]);
      expect(listing.unreadableProposalIds).toEqual(["prop_bad"]);
      await expect(getProposal(context, TENANT_ID, "prop_bad")).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
