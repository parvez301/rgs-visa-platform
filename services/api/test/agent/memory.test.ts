import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import {
  AUTO_APPLIABLE_TOOLS,
  HIGH_STAKES_TOOLS,
  applyApprovedChange,
  stageProposal,
  type ProposedChange,
} from "../../src/agent/approval";
import { recallTool, rememberTool } from "../../src/agent/tools/memoryTools";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { createCase } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { memoryPartitionKey } from "../../src/domain/crm/keys";
import {
  MEMORY_RECALL_PAGE_LIMIT,
  forgetMemory,
  getMemoryOrUndefined,
  memoryRowExists,
  memoryScope,
  parseMemoryScope,
  recallMemories,
  rememberMemory,
} from "../../src/domain/crm/memory";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { GetOptions } from "../../src/lib/db";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ALICE = "alice@rgs.local";
const BOB = "bob@rgs.local";

/** One case, so remember calls have a real sourceCaseId to cite. */
async function seedOneCase(context: TestContext, actorEmail: string, caseRef = "90001") {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: `Ozzy Travels ${caseRef}`, partnerType: "AGENCY" },
    actorEmail,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef,
      caseType: "VISA",
      visaType: "EVISA_TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    },
    actorEmail,
  );
}

describe("memoryScope / parseMemoryScope", () => {
  it("builds and parses the three composite shapes the spec's key layout names", () => {
    expect(memoryScope("ORG")).toBe("ORG");
    expect(memoryScope("PARTNER", "prt_1")).toBe("PARTNER#prt_1");
    expect(memoryScope("USER", ALICE)).toBe(`USER#${ALICE}`);

    expect(parseMemoryScope("ORG")).toEqual({ kind: "ORG" });
    expect(parseMemoryScope("PARTNER#prt_1")).toEqual({ kind: "PARTNER", key: "prt_1" });
    expect(parseMemoryScope(`USER#${ALICE}`)).toEqual({ kind: "USER", key: ALICE });
  });

  it("refuses a string that is none of the three shapes", () => {
    // A synchronous throw, not a rejected promise -- toMatchObject still names
    // the status code rather than a bare toThrow() that cannot tell a 400
    // apart from any other exception (house style, `rejects.toMatchObject`'s
    // sync counterpart).
    let thrownError: unknown;
    try {
      parseMemoryScope("NOT_A_SCOPE");
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toMatchObject({ statusCode: 400 });
  });
});

describe("rememberMemory / recallMemories round trip", () => {
  it("writes a memory citing the case it learned from, and recall reads it back with real provenance", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    const remembered = await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("ORG"),
        memoryKey: "morning-slots",
        text: "prefers morning appointment slots",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );

    // Off every default: createdBy has no .default() (it is a required
    // enum), but pinning it explicitly here is what a mutation to "human"
    // (task-9's mutation check 3) would falsify even on a call that DID
    // supply a sourceCaseId.
    expect(remembered.createdBy).toBe("agent");
    expect(remembered.createdByEmail).toBe(ALICE);
    expect(remembered.sourceCaseId).toBe(seededCase.caseId);

    const { memories, unreadableMemoryKeys } = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
    expect(unreadableMemoryKeys).toEqual([]);
    expect(memories).toEqual([remembered]);
  });

  it("is idempotent by (scope, memoryKey): re-remembering the same key updates in place, no near-duplicate", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");

    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope,
        memoryKey: "morning-slots",
        text: "prefers morning slots, before 10am specifically",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );

    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.text).toBe("prefers morning slots, before 10am specifically");
  });

  it("returns only the scopes asked for, not every scope that exists", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "k1", text: "org fact", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("PARTNER", "prt_1"),
        memoryKey: "k2",
        text: "partner fact",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );

    const { memories: orgOnly } = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
    expect(orgOnly.map((memory) => memory.memoryKey)).toEqual(["k1"]);

    const { memories: partnerOnly } = await recallMemories(context, TENANT_ID, [memoryScope("PARTNER", "prt_1")]);
    expect(partnerOnly.map((memory) => memory.memoryKey)).toEqual(["k2"]);

    const { memories: both } = await recallMemories(context, TENANT_ID, [
      memoryScope("ORG"),
      memoryScope("PARTNER", "prt_1"),
    ]);
    expect(both.map((memory) => memory.memoryKey).sort()).toEqual(["k1", "k2"]);
  });

  it("names a corrupt memory row in unreadableMemoryKeys instead of 500ing the recall", async () => {
    const context = buildTestContext();
    const scope = memoryScope("ORG");
    // A row DynamoDB could hold but CrmMemorySchema refuses -- no `text`,
    // no `createdAt`. Written directly, via the builder (keys.ts is the only
    // file allowed the literal), because rememberMemory itself can never
    // produce a shape this broken.
    await context.table.put({
      PK: memoryPartitionKey(TENANT_ID, scope),
      SK: "half-written",
      tenantId: TENANT_ID,
      scope,
      memoryKey: "half-written",
      createdBy: "agent",
    });

    const { memories, unreadableMemoryKeys } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toEqual([]);
    expect(unreadableMemoryKeys).toEqual(["half-written"]);
  });

  it("refuses an agent-authored memory that cites no source case, and writes nothing", async () => {
    const context = buildTestContext();
    const scope = memoryScope("ORG");

    // The refinement schemas.ts:153-170 exists for: this call passes
    // authorKind "agent", and the schema requires sourceCaseId for exactly
    // that author kind, so a call with no sourceCaseId must be refused
    // through badRequest, not a bare ZodError (router.ts maps only ApiError
    // subclasses). A "human" author has no such requirement -- see "a
    // human-authored memory with no source case" below.
    await expect(
      rememberMemory(context, TENANT_ID, { scope, memoryKey: "no-source", text: "an unearned fact" }, "agent", ALICE),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The other half of "refused": nothing was written, not merely that it threw.
    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toEqual([]);
  });

  // task-11-fix-1-review.md, Group D item 4: before authorKind existed,
  // `createdBy` was always "agent", and the schema's refinement guaranteed
  // `memory.sourceCaseId !== undefined` by the time control reached the
  // `readCaseOrThrow` / `recordCrmEvent` guards in rememberMemory -- the
  // ELSE branch of both guards was unreachable. A "human" author is the
  // first caller ever to reach those guards with sourceCaseId genuinely
  // undefined. Proved here as two separate halves, not one: the memory is
  // written (an admin can file an org-wide policy note with no case to
  // blame it on), and no event lands on any case (there is no case to put
  // one on).
  it("writes a human-authored memory with no source case, and records no event anywhere", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");

    const remembered = await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "no-refunds", text: "No refunds after submission" },
      "human",
      ALICE,
    );
    expect(remembered.createdBy).toBe("human");
    expect(remembered.sourceCaseId).toBeUndefined();

    // First half: the memory really was written and is recallable.
    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toEqual([remembered]);

    // Second half, asserted independently: no MEMORY_REMEMBERED event
    // landed on the one case that exists in this test -- there is nothing
    // else to have wrongly recorded it against, and asserting only the
    // first half would leave a stray event unnoticed.
    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    expect(events.filter((event) => event.eventType === "MEMORY_REMEMBERED")).toEqual([]);

    // task-11-fix-1-review.md's re-review (P62 second half, VACUOUS): the
    // assertion above only proves nothing landed on the ONE case this test
    // happens to seed -- "no event anywhere" was actually "no event on the
    // case I looked at". If `recordCrmEvent`'s guard around `sourceCaseId`
    // is ever removed, `memory.sourceCaseId!` is `undefined`, and
    // `casePartitionKey` coerces that to the literal string "undefined" --
    // a real, distinct partition no seeded case ever occupies. That is
    // exactly where a bug like this hides an orphan row, so this checks
    // that partition directly, by the same key the bug would actually
    // write to.
    const eventsUnderNoCase = await listCaseEvents(context, TENANT_ID, undefined as unknown as string);
    expect(eventsUnderNoCase.filter((event) => event.eventType === "MEMORY_REMEMBERED")).toEqual([]);
  });
});

describe("forgetMemory", () => {
  it("removes a memory recall previously returned", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );
    expect((await recallMemories(context, TENANT_ID, [scope])).memories).toHaveLength(1);

    await forgetMemory(context, TENANT_ID, scope, "morning-slots", ALICE);

    expect((await recallMemories(context, TENANT_ID, [scope])).memories).toEqual([]);
  });

  it("is idempotent: forgetting a memoryKey nobody ever remembered is not an error", async () => {
    const context = buildTestContext();
    await expect(
      forgetMemory(context, TENANT_ID, memoryScope("ORG"), "never-remembered", ALICE),
    ).resolves.toBeUndefined();
  });

  // The security property this task exists for, in the write direction:
  // Task 9's brief secures `recall` (a USER scopeKey never comes from tool
  // input); this is "the same hole facing the other way" -- an actor must
  // not be able to forget (or, symmetrically, write) another user's
  // USER-scope memory, no matter what scope string reaches the domain layer.
  it("refuses to let one user forget another user's USER-scope memory, and deletes nothing", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const aliceScope = memoryScope("USER", ALICE);
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: aliceScope, memoryKey: "private-note", text: "alice's own note", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    await expect(forgetMemory(context, TENANT_ID, aliceScope, "private-note", BOB)).rejects.toMatchObject({
      statusCode: 403,
    });

    // "Refused" alone does not prove nothing happened -- confirm the memory
    // is still exactly there, not merely that the call threw.
    const { memories } = await recallMemories(context, TENANT_ID, [aliceScope]);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.text).toBe("alice's own note");
  });

  it("refuses to let one user remember a fact into another user's USER-scope memory", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    await expect(
      rememberMemory(
        context,
        TENANT_ID,
        { scope: memoryScope("USER", ALICE), memoryKey: "planted", text: "not alice's own words", sourceCaseId: seededCase.caseId },
        "agent",
        BOB,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    const { memories } = await recallMemories(context, TENANT_ID, [memoryScope("USER", ALICE)]);
    expect(memories).toEqual([]);
  });
});

describe("the recall tool", () => {
  it("never returns another user's USER-scope memory, even if the caller tries to name one in the input", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("USER", ALICE),
        memoryKey: "private-note",
        text: "alice's private note",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );

    // A model that has learned alice's email from context and tries to smuggle
    // it in under some other field name -- there is no `userEmail`/`scopeKey`
    // field in RecallToolInput for it to use legitimately, so this stands in
    // for "whatever the model tries," not a real accepted parameter.
    const maliciousInput = { scopes: ["USER"], userEmail: ALICE } as never;
    const result = (await recallTool.execute(context, TENANT_ID, maliciousInput, BOB)) as {
      memories: crm.CrmMemory[];
    };

    expect(result.memories).toEqual([]);
  });

  it("resolves USER scope to whichever actor is actually calling", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ALICE), memoryKey: "k", text: "alice's fact", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    const asAlice = (await recallTool.execute(context, TENANT_ID, { scopes: ["USER"] }, ALICE)) as {
      memories: crm.CrmMemory[];
    };
    expect(asAlice.memories).toHaveLength(1);

    const asBob = (await recallTool.execute(context, TENANT_ID, { scopes: ["USER"] }, BOB)) as {
      memories: crm.CrmMemory[];
    };
    expect(asBob.memories).toEqual([]);
  });

  it("requires a partnerId for PARTNER scope", async () => {
    const context = buildTestContext();
    await expect(
      recallTool.execute(context, TENANT_ID, { scopes: ["PARTNER"] }, ALICE),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("is registered in READ_TOOLS, not WRITE_TOOLS", () => {
    expect(new ToolRegistry(READ_TOOLS).get("recall")?.kind).toBe("read");
    expect(new ToolRegistry(WRITE_TOOLS).get("recall")).toBeUndefined();
  });
});

describe("the remember tool", () => {
  it("reports (new memory) for a first remember, and the prior text for a re-remember", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const tool = new ToolRegistry(WRITE_TOOLS).get("remember")!;

    const firstProposal = (await tool.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    )) as ProposedChange;
    expect(firstProposal.summary).toEqual([
      { field: "ORG/morning-slots", from: "(new memory)", to: "prefers morning slots" },
      { field: "sourceCaseId", from: "(none)", to: seededCase.caseId },
    ]);

    // execute never writes -- apply is the only path to the table.
    await tool.apply!(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    );

    const secondProposal = (await tool.execute(
      context,
      TENANT_ID,
      {
        scope: "ORG",
        memoryKey: "morning-slots",
        text: "prefers morning slots, before 10am",
        sourceCaseId: seededCase.caseId,
      },
      ALICE,
    )) as ProposedChange;
    expect(secondProposal.summary).toEqual([
      { field: "ORG/morning-slots", from: "prefers morning slots", to: "prefers morning slots, before 10am" },
      { field: "sourceCaseId", from: seededCase.caseId, to: seededCase.caseId },
    ]);
  });

  it("applies through rememberMemory, and refuses a sourceCaseId-less proposal with nothing written", async () => {
    const context = buildTestContext();
    const tool = new ToolRegistry(WRITE_TOOLS).get("remember")!;

    await expect(
      tool.apply!(context, TENANT_ID, { scope: "ORG", memoryKey: "no-source", text: "an unearned fact" }, ALICE),
    ).rejects.toMatchObject({ statusCode: 400 });

    const { memories } = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
    expect(memories).toEqual([]);
  });

  it("is registered in WRITE_TOOLS, not READ_TOOLS, with an apply", () => {
    expect(new ToolRegistry(WRITE_TOOLS).get("remember")?.kind).toBe("write");
    expect(new ToolRegistry(WRITE_TOOLS).get("remember")?.apply).toBeTypeOf("function");
    expect(new ToolRegistry(READ_TOOLS).get("remember")).toBeUndefined();
  });
});

describe("the forget tool", () => {
  it("describes the deletion in its diff, and apply removes the row", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const remember = new ToolRegistry(WRITE_TOOLS).get("remember")!;
    const forget = new ToolRegistry(WRITE_TOOLS).get("forget")!;

    await remember.apply!(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    );

    const proposal = (await forget.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "morning-slots" },
      ALICE,
    )) as ProposedChange;
    expect(proposal.summary).toEqual([
      { field: "ORG/morning-slots", from: "prefers morning slots", to: "(forgotten)" },
    ]);

    await forget.apply!(context, TENANT_ID, { scope: "ORG", memoryKey: "morning-slots" }, ALICE);

    const { memories } = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
    expect(memories).toEqual([]);
  });

  it("is registered in WRITE_TOOLS, not READ_TOOLS, with an apply", () => {
    expect(new ToolRegistry(WRITE_TOOLS).get("forget")?.kind).toBe("write");
    expect(new ToolRegistry(WRITE_TOOLS).get("forget")?.apply).toBeTypeOf("function");
    expect(new ToolRegistry(READ_TOOLS).get("forget")).toBeUndefined();
  });
});

// fix round 1, Major 1: the reviewer's own two mutations for this gap --
// (1) hardcode apply's actorEmail to the proposer instead of re-deriving it
// from whoever approves, (2) route a USER-scope remember into the shared ORG
// partition -- both left the suite green before this describe block existed,
// because no test drove a USER-scope remember/forget through the REAL gate
// (stageProposal + applyApprovedChange), only through a tool's own
// execute/apply called directly with one actor throughout. These two tests
// are that missing path: ALICE proposes, BOB approves, and the assertions
// pin the row to BOB's identity by content (`scope`, `createdByEmail`), not
// merely by absence of ALICE's copy.
describe("the acting identity, through the real approval gate (fix round 1, Major 1)", () => {
  it("a USER-scope remember lands under the acting identity, never under the one that proposed it", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const rememberTool = new ToolRegistry(WRITE_TOOLS).get("remember")!;

    const proposal = (await rememberTool.execute(
      context,
      TENANT_ID,
      { scope: "USER", memoryKey: "slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, BOB);

    // Not under ALICE, who proposed it -- kills mutation (1), hardcoding
    // apply's actorEmail to the proposer.
    expect((await recallMemories(context, TENANT_ID, [memoryScope("USER", ALICE)])).memories).toEqual([]);

    // Under BOB's own USER partition, not the shared ORG one -- kills
    // mutation (2), routing a USER-scope remember into ORG.
    const bobsMemories = (await recallMemories(context, TENANT_ID, [memoryScope("USER", BOB)])).memories;
    expect(bobsMemories).toHaveLength(1);
    expect(bobsMemories[0]?.scope).toBe(memoryScope("USER", BOB));
    expect(bobsMemories[0]?.createdByEmail).toBe(BOB);

    // And ORG stays empty -- the second half of "not routed into ORG":
    // nothing leaked into the scope every user's recall(["ORG"]) reads.
    expect((await recallMemories(context, TENANT_ID, [memoryScope("ORG")])).memories).toEqual([]);
  });

  it("a USER-scope forget by the approver only ever touches the approver's own row, never the proposer's", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    // Seeded directly through the domain layer under the SAME memoryKey BOB
    // is about to forget, so a leak shows up as alice's row disappearing --
    // not merely as "nothing was deleted".
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("USER", ALICE),
        memoryKey: "slots",
        text: "alice's own note",
        sourceCaseId: seededCase.caseId,
      },
      "agent",
      ALICE,
    );

    const forgetTool = new ToolRegistry(WRITE_TOOLS).get("forget")!;
    const proposal = (await forgetTool.execute(
      context,
      TENANT_ID,
      { scope: "USER", memoryKey: "slots" },
      ALICE,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, BOB);

    // BOB's forget resolves to USER#bob, which held nothing -- a no-op --
    // and ALICE's row, seeded above under the identical memoryKey, must
    // still be exactly there.
    const alicesMemories = (await recallMemories(context, TENANT_ID, [memoryScope("USER", ALICE)])).memories;
    expect(alicesMemories).toHaveLength(1);
    expect(alicesMemories[0]?.text).toBe("alice's own note");
  });
});

// fix round 1, Major 3: an ORG-scope and a USER-scope remember of the exact
// same text must not render as the same approval card -- an approver reading
// only the summary needs to be able to tell which scope they are approving.
describe("the approval card names the scope (fix round 1, Major 3)", () => {
  it("an ORG-scope and a USER-scope remember of identical text produce differing summary fields", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const rememberTool = new ToolRegistry(WRITE_TOOLS).get("remember")!;

    const orgProposal = (await rememberTool.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    )) as ProposedChange;
    const userProposal = (await rememberTool.execute(
      context,
      TENANT_ID,
      { scope: "USER", memoryKey: "slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    )) as ProposedChange;

    expect(orgProposal.summary[0]?.field).toBe("ORG/slots");
    expect(userProposal.summary[0]?.field).toBe("USER/slots");
    expect(orgProposal.summary[0]?.field).not.toBe(userProposal.summary[0]?.field);
  });
});

describe("recallMemories dedupes and caps (fix round 1, Minor 1 & 2)", () => {
  it("does not double-return a memory when the same scope appears twice in the request", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    const { memories } = await recallMemories(context, TENANT_ID, [scope, scope]);
    expect(memories).toHaveLength(1);
  });

  it("caps each scope's own query at the default MEMORY_RECALL_PAGE_LIMIT", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");
    for (let memoryIndex = 0; memoryIndex < MEMORY_RECALL_PAGE_LIMIT + 5; memoryIndex += 1) {
      await rememberMemory(
        context,
        TENANT_ID,
        { scope, memoryKey: `k${memoryIndex}`, text: `fact ${memoryIndex}`, sourceCaseId: seededCase.caseId },
        "agent",
        ALICE,
      );
    }

    const { memories: uncapped } = await recallMemories(context, TENANT_ID, [scope]);
    expect(uncapped).toHaveLength(MEMORY_RECALL_PAGE_LIMIT);

    const { memories: explicitlyCapped } = await recallMemories(context, TENANT_ID, [scope], 3);
    expect(explicitlyCapped).toHaveLength(3);
  });

  it("the recall tool's own limit input is honored and capped at MEMORY_RECALL_PAGE_LIMIT by its schema", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "k1", text: "fact one", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "k2", text: "fact two", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    const result = (await recallTool.execute(context, TENANT_ID, { scopes: ["ORG"], limit: 1 }, ALICE)) as {
      memories: crm.CrmMemory[];
    };
    expect(result.memories).toHaveLength(1);

    // The schema itself refuses a limit above the cap -- this is a Zod
    // parse failure at the router boundary, not something recallTool.execute
    // enforces by hand, so this asserts the schema, not the tool function.
    const parseResult = recallTool.inputSchema.safeParse({
      scopes: ["ORG"],
      limit: MEMORY_RECALL_PAGE_LIMIT + 1,
    });
    expect(parseResult.success).toBe(false);
  });
});

describe("forget's sentinel distinguishes never-remembered from remembered-then-forgotten (fix round 1, Minor 3)", () => {
  it("renders the nothing-to-forget sentinel, not the new-memory sentinel, for a key nobody ever remembered", async () => {
    const context = buildTestContext();
    const forgetTool = new ToolRegistry(WRITE_TOOLS).get("forget")!;

    const proposal = (await forgetTool.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "never-remembered" },
      ALICE,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "ORG/never-remembered", from: "(nothing remembered)", to: "(forgotten)" },
    ]);
    // Distinct from remember's own sentinel for the same situation -- the
    // two must not collide, or a nothing-to-forget card would misread as a
    // creation being immediately destroyed.
    expect(proposal.summary[0]?.from).not.toBe("(new memory)");
  });
});

describe("rememberMemory records a case-timeline event (fix round 1, Minor 5)", () => {
  it("records a MEMORY_REMEMBERED event on the source case when sourceCaseId is given", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    const memoryEvents = events.filter((event) => event.eventType === "MEMORY_REMEMBERED");
    expect(memoryEvents).toHaveLength(1);
    expect(memoryEvents[0]?.actorEmail).toBe(ALICE);
    // createdBy on the event meta, not only on the memory row itself: ruling
    // P25's own precedent (autoApplied on PROPOSAL_APPROVED) -- a timeline
    // entry that cannot distinguish a human act from an agent act is not an
    // audit trail.
    expect(memoryEvents[0]?.meta).toMatchObject({
      scope: memoryScope("ORG"),
      memoryKey: "morning-slots",
      createdBy: "agent",
    });
  });

  it("records nothing when rememberMemory rejects a sourceCaseId-less proposal before ever reaching the write", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    // This call passes authorKind "agent", and the schema refuses "agent"
    // with no sourceCaseId (tested above, "refuses an agent-authored
    // memory..."), so the `memory.sourceCaseId !== undefined` guard in
    // rememberMemory can only ever see a defined sourceCaseId for THIS call
    // -- this pins the ordering that makes that true: the schema throws
    // before recordCrmEvent is ever called, so a rejected remember leaves
    // the seeded case's timeline untouched, not merely "no event about this
    // specific memory". A "human" author reaches this same guard with
    // sourceCaseId genuinely undefined and is not rejected -- see "a
    // human-authored memory with no source case" below, which proves the
    // guard skips recordCrmEvent rather than throwing.
    await expect(
      rememberMemory(context, TENANT_ID, { scope: memoryScope("ORG"), memoryKey: "no-source", text: "an unearned fact" }, "agent", ALICE),
    ).rejects.toMatchObject({ statusCode: 400 });

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    expect(events.filter((event) => event.eventType === "MEMORY_REMEMBERED")).toHaveLength(0);
  });

  it("forgetMemory records no event on any case, regardless of scope", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "morning-slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );

    await forgetMemory(context, TENANT_ID, scope, "morning-slots", ALICE);

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    // Only the one event remember itself recorded -- forget added none.
    expect(events.filter((event) => event.eventType === "MEMORY_REMEMBERED")).toHaveLength(1);
  });
});

// fix round 2: task-9-fix-1-review.md's own m5 fix introduced this gap --
// rememberMemory started writing an EVENT# row against `sourceCaseId`
// without ever checking the case exists. Mandatory mutation (a): remove the
// readCaseOrThrow call below and confirm the first test here goes red.
describe("rememberMemory validates sourceCaseId against a real case (fix round 2, item 1)", () => {
  it("rejects a sourceCaseId naming no real case, and writes neither the memory row nor an orphan event", async () => {
    const context = buildTestContext();
    const scope = memoryScope("ORG");
    const phantomCaseId = "case_does_not_exist";

    await expect(
      rememberMemory(
        context,
        TENANT_ID,
        { scope, memoryKey: "orphan", text: "a fact citing nothing real", sourceCaseId: phantomCaseId },
        "agent",
        ALICE,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Nothing written at all -- not the memory row (the ordering choice:
    // the case is validated BEFORE writeMemory runs, not after), and not an
    // orphan EVENT# row in the phantom case's own, otherwise-empty partition.
    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toEqual([]);
    expect(await listCaseEvents(context, TENANT_ID, phantomCaseId)).toEqual([]);
  });

  it("still succeeds, and still records its event, when sourceCaseId names a real case", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);
    const scope = memoryScope("ORG");

    const remembered = await rememberMemory(
      context,
      TENANT_ID,
      { scope, memoryKey: "real-case", text: "a fact citing something real", sourceCaseId: seededCase.caseId },
      "agent",
      ALICE,
    );
    expect(remembered.sourceCaseId).toBe(seededCase.caseId);

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    expect(events.filter((event) => event.eventType === "MEMORY_REMEMBERED")).toHaveLength(1);
  });
});

// fix round 2, item 2: the other half of Major 3. Mandatory mutation (b):
// drop the sourceCaseId entry from rememberTool's summary and confirm the
// first test here goes red.
describe("the approval card names the source case (fix round 2, item 2)", () => {
  it("shows sourceCaseId on the remember card, not only scope and memoryKey", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, ALICE);

    const proposal = (await rememberTool.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "slots", text: "prefers morning slots", sourceCaseId: seededCase.caseId },
      ALICE,
    )) as ProposedChange;

    const sourceCaseIdEntry = proposal.summary.find((entry) => entry.field === "sourceCaseId");
    expect(sourceCaseIdEntry?.to).toBe(seededCase.caseId);
  });

  it("says plainly, not blankly, when no sourceCaseId was given at all", async () => {
    const context = buildTestContext();

    const proposal = (await rememberTool.execute(
      context,
      TENANT_ID,
      { scope: "ORG", memoryKey: "no-source", text: "an unearned fact" },
      ALICE,
    )) as ProposedChange;

    const sourceCaseIdEntry = proposal.summary.find((entry) => entry.field === "sourceCaseId");
    expect(sourceCaseIdEntry?.to).toBe("(none -- will be rejected on apply)");
  });

  it("rejects an empty-string sourceCaseId at the schema level, before it ever reaches rememberMemory", () => {
    const parseResult = rememberTool.inputSchema.safeParse({
      scope: "ORG",
      memoryKey: "k",
      text: "t",
      sourceCaseId: "",
    });
    expect(parseResult.success).toBe(false);
  });
});

// Ruling P46 / task-9-controller-notes.md §5: registering two new write
// tools has consequences for the approval gate's classification sets.
describe("remember/forget classification (ruling P46, §5)", () => {
  it("puts both in HIGH_STAKES_TOOLS -- staged and confirmed like any other write, never auto-applied", () => {
    expect(HIGH_STAKES_TOOLS.has("remember")).toBe(true);
    expect(HIGH_STAKES_TOOLS.has("forget")).toBe(true);
  });

  it("leaves both out of AUTO_APPLIABLE_TOOLS at every trust level", () => {
    expect(AUTO_APPLIABLE_TOOLS.has("remember")).toBe(false);
    expect(AUTO_APPLIABLE_TOOLS.has("forget")).toBe(false);
  });
});

// Branch review I1. Both single-row memory reads take the same strong-read
// opt-in caseStore.readCase takes (db.ts's GetOptions: "an eventually
// consistent get can miss an item that was written moments earlier, which
// reads back as a record that does not exist").
//
// Pinned by capturing GetOptions, the way caseRefIndex.test.ts pins its own:
// InMemoryTableClient is always strongly consistent, so no behavioural test
// in this suite can tell the two apart -- the flag is the only observable.
describe("the single-row memory reads are strongly consistent", () => {
  function watchGetOptions(context: TestContext): {
    watchingContext: AppContext;
    lastGetOptions: () => GetOptions | undefined;
  } {
    let capturedGetOptions: GetOptions | undefined;
    const watchingContext: AppContext = {
      ...context,
      table: {
        get: (partitionKey, sortKey, options) => {
          capturedGetOptions = options;
          return context.table.get(partitionKey, sortKey, options);
        },
        put: (item) => context.table.put(item),
        delete: (partitionKey, sortKey) => context.table.delete(partitionKey, sortKey),
        query: (partitionKey, options) => context.table.query(partitionKey, options),
        queryGsi: (indexName, partitionKey, options) =>
          context.table.queryGsi(indexName, partitionKey, options),
      },
    };
    return { watchingContext, lastGetOptions: () => capturedGetOptions };
  }

  // A stale miss here shows the approver "(new memory)" as the card's `from`
  // for a key that already holds text -- an overwrite rendered as a creation.
  it("getMemoryOrUndefined reads consistently, so a write tool's card cannot show a stale prior value", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context, ALICE);
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "slots", text: "prefers mornings", sourceCaseId: seeded.caseId },
      "human",
      ALICE,
    );
    const { watchingContext, lastGetOptions } = watchGetOptions(context);

    await getMemoryOrUndefined(watchingContext, TENANT_ID, memoryScope("ORG"), "slots");
    expect(lastGetOptions()?.consistentRead).toBe(true);
  });

  // A stale miss here makes the admin DELETE route report `forgotten: false`
  // for a row it is about to delete -- the exact dishonesty that
  // read-before-delete exists to prevent.
  it("memoryRowExists reads consistently, so the DELETE route cannot under-report a real deletion", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context, ALICE, "90002");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "slots", text: "prefers mornings", sourceCaseId: seeded.caseId },
      "human",
      ALICE,
    );
    const { watchingContext, lastGetOptions } = watchGetOptions(context);

    await expect(memoryRowExists(watchingContext, TENANT_ID, memoryScope("ORG"), "slots")).resolves.toBe(true);
    expect(lastGetOptions()?.consistentRead).toBe(true);
  });
});
