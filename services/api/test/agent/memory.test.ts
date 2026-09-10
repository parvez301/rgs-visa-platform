import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { AUTO_APPLIABLE_TOOLS, HIGH_STAKES_TOOLS, type ProposedChange } from "../../src/agent/approval";
import { recallTool } from "../../src/agent/tools/memoryTools";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { createCase } from "../../src/domain/crm/cases";
import { memoryPartitionKey } from "../../src/domain/crm/keys";
import {
  forgetMemory,
  memoryScope,
  parseMemoryScope,
  recallMemories,
  rememberMemory,
} from "../../src/domain/crm/memory";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
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

    // The refinement schemas.ts:153-170 exists for: createdBy is always
    // "agent" here (rememberMemory's own doing, not caller-supplied), so a
    // call with no sourceCaseId must be refused through badRequest, not a
    // bare ZodError (router.ts maps only ApiError subclasses).
    await expect(
      rememberMemory(context, TENANT_ID, { scope, memoryKey: "no-source", text: "an unearned fact" }, ALICE),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The other half of "refused": nothing was written, not merely that it threw.
    const { memories } = await recallMemories(context, TENANT_ID, [scope]);
    expect(memories).toEqual([]);
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
    expect(firstProposal.summary).toEqual([{ field: "text", from: "(new memory)", to: "prefers morning slots" }]);

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
      { field: "text", from: "prefers morning slots", to: "prefers morning slots, before 10am" },
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
      { field: "text", from: "prefers morning slots", to: "(forgotten)" },
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
