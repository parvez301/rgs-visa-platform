import { describe, expect, it } from "vitest";
import { extractIntake, type IntakeDraft } from "../../src/agent/intake";
import { FakeLlmProvider, type ScriptedTurn } from "../../src/agent/providers/fake";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

interface RawExtractionOverrides {
  travellerFullName?: string;
  passportNumber?: string;
  destinationCountryRaw?: string;
  partnerNameRaw?: string;
  applicantCount?: number;
  missingDocuments?: string[];
}

/** Every field of RawIntakeExtractionSchema is required -- this fills in the
 * "nothing stated" sentinels ("" / 0 / []) so a test only has to name what it
 * actually cares about. */
function scriptedExtraction(overrides: RawExtractionOverrides = {}): ScriptedTurn {
  return {
    text: JSON.stringify({
      travellerFullName: overrides.travellerFullName ?? "",
      passportNumber: overrides.passportNumber ?? "",
      destinationCountryRaw: overrides.destinationCountryRaw ?? "",
      partnerNameRaw: overrides.partnerNameRaw ?? "",
      applicantCount: overrides.applicantCount ?? 0,
      missingDocuments: overrides.missingDocuments ?? [],
    }),
    toolCalls: [],
  };
}

function buildTestContextWithFakeLlm(scriptedTurns: ScriptedTurn[]): TestContext & { llm: FakeLlmProvider } {
  const context = buildTestContext();
  return Object.assign(context, { llm: new FakeLlmProvider(scriptedTurns) });
}

/**
 * Wraps a real context's table so a read still works -- extractIntake reads
 * the traveller/partner stores to resolve what the model extracted -- but any
 * put/delete throws immediately. Mirrors `refuseWrites` in
 * writeTools.test.ts, which polices the identical property (execute never
 * reaches the table) for every write tool; this is the same proof for
 * extractIntake, which controller-notes §3 requires explicitly: "intake is a
 * read-and-propose path with no exceptions."
 */
function refuseWrites(context: TestContext & { llm: FakeLlmProvider }): AppContext & { llm: FakeLlmProvider } {
  return {
    ...context,
    table: {
      get: (partitionKey, sortKey, options) => context.table.get(partitionKey, sortKey, options),
      query: (partitionKey, options) => context.table.query(partitionKey, options),
      queryGsi: (indexName, partitionKey, options) =>
        context.table.queryGsi(indexName, partitionKey, options),
      put: () => {
        throw new Error("extractIntake reached table.put() -- intake must never write");
      },
      delete: () => {
        throw new Error("extractIntake reached table.delete() -- intake must never write");
      },
    },
  };
}

describe("extractIntake", () => {
  it("throws badRequest (400) when the context has no LLM provider wired in, without touching it", async () => {
    const context = buildTestContext();
    await expect(extractIntake(context, TENANT_ID, "2 pax for japan", ACTOR)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("resolves a known passport to the existing travellerId, and carries the raw name alongside it", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({
        travellerFullName: "Ashok Kumar",
        passportNumber: "N1234567",
        destinationCountryRaw: "japan",
        applicantCount: 1,
      }),
    ]);
    const traveller = await upsertTraveller(context, TENANT_ID, {
      fullName: "Ashok Kumar",
      passportNumber: "N1234567",
    });

    const draft = await extractIntake(context, TENANT_ID, "irrelevant -- FakeLlmProvider is scripted", ACTOR);

    expect(draft.applicants).toEqual([
      { applicantRef: "A1", travellerId: traveller.travellerId, passportNumber: "N1234567" },
    ]);
    expect(draft.travellerFullName).toBe("Ashok Kumar");
    expect(draft.passportNumber).toBe("N1234567");
    expect(draft.destinationCountry).toBe("JP");
    expect(draft.unresolvedCountry).toBeUndefined();
  });

  it("surfaces a passport that matches no traveller as an empty applicants list, never a minted traveller", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ travellerFullName: "New Client", passportNumber: "Z9999999", applicantCount: 1 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.applicants).toEqual([]);
    expect(draft.travellerFullName).toBe("New Client");
    expect(draft.passportNumber).toBe("Z9999999");
  });

  it("resolves a known partner name to its partnerId", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ partnerNameRaw: "Ozzy Travels", applicantCount: 1 }),
    ]);
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
      ACTOR,
    );

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.partnerId).toBe(partner.partnerId);
    expect(draft.unresolvedPartnerName).toBeUndefined();
  });

  // The real-workbook trap (docs/migration-questions-for-rgs.md: 78 rows) --
  // matches no agency on file. The default this codebase chose for a name
  // like this is its OWN partner record (partners.ts normalizePartnerName's
  // AMBIGUOUS_ACCOUNT_KEYS), but that is a migration-time decision made once
  // by a human; extractIntake must not silently repeat it as a live write.
  it("an unknown partner name surfaces as unresolvedPartnerName, never a new partner", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ partnerNameRaw: "SAMMY A/C", applicantCount: 1 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.unresolvedPartnerName).toBe("SAMMY A/C");
    expect(draft.partnerId).toBeUndefined();
  });

  it("resolves a plainly-spelled destination country to its ISO-3166 alpha-2 code", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ destinationCountryRaw: "Thailand", applicantCount: 1 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.destinationCountry).toBe("TH");
    expect(draft.unresolvedCountry).toBeUndefined();
  });

  // Real-workbook trap: a service line sitting in the country column (34
  // rows). "PASSPORT NEW" is not a country in any spelling map, so it must
  // come out unresolved -- confidently mapping it to a destination is
  // exactly the failure controller-notes §2 scores as worse than a refusal.
  it("a service line in the destination position surfaces as unresolvedCountry, never a guessed country", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ destinationCountryRaw: "PASSPORT NEW", applicantCount: 1 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.unresolvedCountry).toBe("PASSPORT NEW");
    expect(draft.destinationCountry).toBeUndefined();
  });

  // Real-workbook trap: a misspelling of a country the shared map does not
  // even carry a correct spelling for (packages/shared/src/crm/normalize/
  // country.ts has no MYANMAR entry at all) -- unresolved regardless of
  // whether the model repeats the typo or "corrects" it.
  it("a misspelled country not in the shared map surfaces as unresolvedCountry", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ destinationCountryRaw: "Myannmar", applicantCount: 1 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.unresolvedCountry).toBe("Myannmar");
    expect(draft.destinationCountry).toBeUndefined();
  });

  // Real-workbook trap: a multi-destination trip. One case cannot carry two
  // ISO-3166 codes in a single destinationCountry field, so this must stay
  // unresolved rather than the pipeline picking one destination and
  // silently discarding the other.
  it("a multi-country destination surfaces as unresolvedCountry rather than picking one", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ destinationCountryRaw: "TANZANIA/KENYA", applicantCount: 2 }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.unresolvedCountry).toBe("TANZANIA/KENYA");
    expect(draft.destinationCountry).toBeUndefined();
  });

  it("never invents a value for a field the text did not state -- everything stays absent, not defaulted", async () => {
    const context = buildTestContextWithFakeLlm([scriptedExtraction()]);

    const draft = await extractIntake(context, TENANT_ID, "no useful information here", ACTOR);

    const expectedDraft: IntakeDraft = {
      applicantCount: 0,
      applicants: [],
      receivedDate: context.now().toISOString().slice(0, 10),
      caseType: "VISA",
      missingDocuments: [],
    };
    expect(draft).toEqual(expectedDraft);
  });

  it("carries missingDocuments straight through from the extraction", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ applicantCount: 1, missingDocuments: ["passport copy", "photo"] }),
    ]);

    const draft = await extractIntake(context, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.missingDocuments).toEqual(["passport copy", "photo"]);
  });

  it("throws badRequest (400) when the model's reply is not valid JSON", async () => {
    const context = buildTestContextWithFakeLlm([{ text: "not json at all", toolCalls: [] }]);

    await expect(extractIntake(context, TENANT_ID, "irrelevant", ACTOR)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("throws badRequest (400), not a raw ZodError, when the model's JSON does not match the extraction shape", async () => {
    const context = buildTestContextWithFakeLlm([
      { text: JSON.stringify({ unexpected: "shape" }), toolCalls: [] },
    ]);

    await expect(extractIntake(context, TENANT_ID, "irrelevant", ACTOR)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("calls the provider with tools: [] and a responseSchema, never through runAgentTurn's tool-bearing path", async () => {
    const context = buildTestContextWithFakeLlm([
      scriptedExtraction({ travellerFullName: "Asha Rao", applicantCount: 1 }),
    ]);

    await extractIntake(context, TENANT_ID, "Asha Rao, 1 pax, Japan", ACTOR);

    expect(context.llm.receivedRequests).toHaveLength(1);
    const sentRequest = context.llm.receivedRequests[0];
    expect(sentRequest?.tools).toEqual([]);
    expect(sentRequest?.responseSchema).toBeDefined();
    expect(sentRequest?.messages).toEqual([
      { role: "user", content: "Asha Rao, 1 pax, Japan" },
    ]);
  });

  // controller-notes §3: no exceptions. Proven the same way writeTools.test.ts
  // proves it for every write tool -- reads succeed, but reaching put/delete
  // throws immediately. Exercised with BOTH a resolving passport and a
  // resolving partner name on the same call, so every read branch this
  // function has runs against a table that would blow up on any write.
  it("performs no table write at all, even when both the traveller and the partner resolve", async () => {
    const seedContext = buildTestContext();
    const traveller = await upsertTraveller(seedContext, TENANT_ID, {
      fullName: "Priya Nair",
      passportNumber: "K7654321",
    });
    const partner = await createPartner(
      seedContext,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
      ACTOR,
    );

    const contextWithLlm = Object.assign(seedContext, {
      llm: new FakeLlmProvider([
        scriptedExtraction({
          travellerFullName: "Priya Nair",
          passportNumber: "K7654321",
          partnerNameRaw: "Ozzy Travels",
          destinationCountryRaw: "Japan",
          applicantCount: 1,
        }),
      ]),
    });
    const writeRefusingContext = refuseWrites(contextWithLlm);

    const draft = await extractIntake(writeRefusingContext, TENANT_ID, "irrelevant", ACTOR);

    expect(draft.applicants).toEqual([
      { applicantRef: "A1", travellerId: traveller.travellerId, passportNumber: "K7654321" },
    ]);
    expect(draft.partnerId).toBe(partner.partnerId);
    expect(draft.destinationCountry).toBe("JP");
  });
});
