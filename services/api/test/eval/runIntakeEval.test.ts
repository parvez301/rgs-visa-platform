import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyTrapFidelity,
  buildEvalContext,
  EVAL_THRESHOLDS,
  EvalCaseSchema,
  evaluateThreshold,
  scoreCase,
  scoreStringField,
  scoreTravellerResolution,
  seedFixtures,
  summarize,
  wasFieldAttempted,
  type CaseResult,
  type EvalCase,
  type ProviderScorecard,
} from "../../eval/runIntakeEval";
import { FakeLlmProvider, type ScriptedTurn } from "../../src/agent/providers/fake";
import type { IntakeDraft } from "../../src/agent/intake";

/**
 * task-12-review.md M2/A3: before this round, `runIntakeEval.ts` exported
 * nothing and called `main()` unconditionally at module scope, so the code
 * that will justify a real purchasing decision could not be imported by a
 * test without spending money running it. This file is that missing
 * coverage: direct unit tests for the new pure scoring functions, plus the
 * review's own five-strategy methodology (a faithful decliner, a confident
 * guesser, a realistic "helpful" corrector, and two degenerate strategies)
 * driven through the REAL `scoreCase`/`summarize` with `FakeLlmProvider` --
 * no network call, no live provider, ever.
 */

async function loadRealCases(): Promise<EvalCase[]> {
  const casesFileUrl = new URL("../../eval/intakeCases.json", import.meta.url);
  const rawCasesJson = JSON.parse(await readFile(casesFileUrl, "utf8"));
  return z.array(EvalCaseSchema).parse(rawCasesJson);
}

function zeroScorecard(): ProviderScorecard {
  return {
    exactFieldAccuracy: 0,
    fieldsScored: 0,
    fieldsCorrect: 0,
    hallucinationRate: 0,
    hallucinationOpportunities: 0,
    hallucinatedFields: 0,
    coverage: 0,
    fieldsFilled: 0,
    fieldsFillable: 0,
    class2TrapRecall: 0,
    class2TrapsTotal: 0,
    class2TrapsSatisfied: 0,
    class1TrapAccuracy: 0,
    class1TrapsTotal: 0,
    class1TrapsSatisfied: 0,
  };
}

function emptyDraft(overrides: Partial<IntakeDraft> = {}): IntakeDraft {
  return { applicantCount: 0, applicants: [], receivedDate: "2026-01-01", missingDocuments: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Direct unit tests for the new pure functions
// ---------------------------------------------------------------------------

describe("scoreStringField", () => {
  it("matches names case- and word-order-insensitively", () => {
    expect(scoreStringField("travellerFullName", "Ashok Kumar", "kumar ashok").correct).toBe(true);
  });

  it("requires an exact code match for destinationCountry, not name-style matching", () => {
    expect(scoreStringField("destinationCountry", "TH", "th").correct).toBe(true);
    expect(scoreStringField("destinationCountry", "TH", "IN").correct).toBe(false);
  });

  it("flags a non-null actual against a null expectation as hallucinated", () => {
    const score = scoreStringField("partnerName", null, "Made Up Agency");
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(true);
  });

  it("does not flag an honest null-vs-null match as hallucinated", () => {
    const score = scoreStringField("partnerName", null, null);
    expect(score.correct).toBe(true);
    expect(score.hallucinated).toBe(false);
  });
});

describe("wasFieldAttempted (task-12-review.md A4/M3's coverage number)", () => {
  it("counts a resolved destinationCountry as attempted", () => {
    expect(wasFieldAttempted(emptyDraft({ destinationCountry: "TH" }), "destinationCountry")).toBe(true);
  });

  it("counts an UNresolved destinationCountry as attempted too -- coverage must not conflate silence with a correct refusal", () => {
    expect(wasFieldAttempted(emptyDraft({ unresolvedCountry: "PASSPORT NEW" }), "destinationCountry")).toBe(true);
  });

  it("counts neither resolved nor unresolved as not attempted", () => {
    expect(wasFieldAttempted(emptyDraft(), "destinationCountry")).toBe(false);
  });

  it("counts a resolved partnerId or an unresolvedPartnerName as attempted, and neither as not attempted", () => {
    expect(wasFieldAttempted(emptyDraft({ partnerId: "prt_1" }), "partnerName")).toBe(true);
    expect(wasFieldAttempted(emptyDraft({ unresolvedPartnerName: "SAMMY A/C" }), "partnerName")).toBe(true);
    expect(wasFieldAttempted(emptyDraft(), "partnerName")).toBe(false);
  });
});

describe("scoreTravellerResolution (task-12-review.md m2)", () => {
  const seededPassportCase: EvalCase = {
    id: "t-seeded",
    rawText: "irrelevant",
    seed: { traveller: { fullName: "X", passportNumber: "K7654321" } },
    expected: { travellerFullName: "X", passportNumber: "K7654321", destinationCountry: null, partnerName: null, applicantCount: 1 },
  };
  const noSeedCase: EvalCase = {
    id: "t-no-seed",
    rawText: "irrelevant",
    expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 1 },
  };

  it("is correct when the expected passport was seeded and the draft attaches exactly that traveller", () => {
    const draft = emptyDraft({ applicants: [{ applicantRef: "A1", travellerId: "trv_1", passportNumber: "K7654321" }] });
    expect(scoreTravellerResolution(seededPassportCase, draft).correct).toBe(true);
  });

  it("is WRONG when a passport was seeded and should resolve, but the draft attached no traveller -- a deleted findTravellerByPassport call must not score 100%", () => {
    const score = scoreTravellerResolution(seededPassportCase, emptyDraft());
    expect(score.correct).toBe(false);
  });

  it("is correct when nothing was seeded and the draft attaches no traveller", () => {
    expect(scoreTravellerResolution(noSeedCase, emptyDraft()).correct).toBe(true);
  });

  it("flags an unexpectedly-attached traveller as hallucinated", () => {
    const draft = emptyDraft({ applicants: [{ applicantRef: "A1", travellerId: "trv_1", passportNumber: "Z1" }] });
    const score = scoreTravellerResolution(noSeedCase, draft);
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(true);
  });

  // The tests above prove scoreTravellerResolution is correct in isolation --
  // this one proves scoreCase actually CALLS it. Without this, deleting the
  // wiring (not the function itself) would leave every unit test above green
  // while the eval itself went back to never scoring traveller resolution at
  // all (task-12-review.md m2's original defect).
  it("scoreCase includes a travellerResolution field score in its output", async () => {
    const seedContext = buildEvalContext(
      new FakeLlmProvider([
        {
          text: JSON.stringify({
            travellerFullName: "Priya Nair",
            passportNumber: "K7654321",
            destinationCountryRaw: "",
            partnerNameRaw: "",
            applicantCount: 1,
            missingDocuments: [],
          }),
          toolCalls: [],
        },
      ]),
    );
    const evalCase: EvalCase = {
      id: "t-wiring",
      rawText: "irrelevant",
      seed: { traveller: { fullName: "Priya Nair", passportNumber: "K7654321" } },
      expected: {
        travellerFullName: "Priya Nair",
        passportNumber: "K7654321",
        destinationCountry: null,
        partnerName: null,
        applicantCount: 1,
      },
    };
    await seedFixtures(seedContext, [evalCase]);

    const caseResult = await scoreCase(seedContext, evalCase);
    const travellerResolutionScore = caseResult.fieldScores.find(
      (fieldScore) => fieldScore.field === "travellerResolution",
    );
    expect(travellerResolutionScore).toBeDefined();
    expect(travellerResolutionScore?.correct).toBe(true);
  });
});

describe("applyTrapFidelity (task-12-review.md C1)", () => {
  const class2Case: EvalCase = {
    id: "t-class2",
    rawText: "irrelevant",
    trapField: "destinationCountry",
    trapRawText: "PASSPORT NEW",
    expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 1 },
  };

  it("credits an honest, verbatim-matching refusal as satisfied and leaves the field score untouched", () => {
    const draft = emptyDraft({ unresolvedCountry: "PASSPORT NEW" });
    const fieldScores = [scoreStringField("destinationCountry", null, null)];
    const result = applyTrapFidelity(class2Case, draft, fieldScores);
    expect(result.trapOutcome).toEqual({
      field: "destinationCountry",
      trapClass: "unresolved",
      satisfied: true,
      fabricatedRaw: false,
    });
    expect(result.fieldScores[0]).toEqual(fieldScores[0]);
  });

  it("C1: catches a fabricated raw value that ALSO fails to resolve -- the exact regression the review reproduced", () => {
    // Before this fix, `destinationCountry === null` alone made this
    // indistinguishable from an honest refusal: the model said "India" (not
    // in the country map either), so it stayed unresolved on the surface.
    const draft = emptyDraft({ unresolvedCountry: "India" });
    const fieldScores = [scoreStringField("destinationCountry", null, null)];
    const result = applyTrapFidelity(class2Case, draft, fieldScores);
    expect(result.trapOutcome?.satisfied).toBe(false);
    expect(result.trapOutcome?.fabricatedRaw).toBe(true);
    expect(result.fieldScores[0]?.correct).toBe(false);
    expect(result.fieldScores[0]?.hallucinated).toBe(true);
  });

  it("does not flag fabrication when the field actually resolved (there is a real, non-null actual to judge on its own terms)", () => {
    const draft = emptyDraft({ destinationCountry: "TH" });
    const fieldScores = [scoreStringField("destinationCountry", null, "TH")];
    const result = applyTrapFidelity(class2Case, draft, fieldScores);
    expect(result.trapOutcome?.fabricatedRaw).toBe(false);
    expect(result.trapOutcome?.satisfied).toBe(false); // still wrong -- it resolved when it should not have
  });

  it("Class 1 (trapClass: resolves): correct behaviour is resolving to the expected value, not staying unresolved", () => {
    const class1Case: EvalCase = {
      id: "t-class1",
      rawText: "irrelevant",
      trapField: "destinationCountry",
      trapClass: "resolves",
      expected: { travellerFullName: null, passportNumber: null, destinationCountry: "MM", partnerName: null, applicantCount: 1 },
    };

    const resolvedResult = applyTrapFidelity(
      class1Case,
      emptyDraft({ destinationCountry: "MM" }),
      [scoreStringField("destinationCountry", "MM", "MM")],
    );
    expect(resolvedResult.trapOutcome?.satisfied).toBe(true);

    const unresolvedResult = applyTrapFidelity(
      class1Case,
      emptyDraft({ unresolvedCountry: "Myannmar" }),
      [scoreStringField("destinationCountry", "MM", null)],
    );
    expect(unresolvedResult.trapOutcome?.satisfied).toBe(false);
  });

  it("returns no trapOutcome for a case with no trapField", () => {
    const plainCase: EvalCase = {
      id: "t-plain",
      rawText: "irrelevant",
      expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 1 },
    };
    const result = applyTrapFidelity(plainCase, emptyDraft(), [scoreStringField("destinationCountry", null, null)]);
    expect(result.trapOutcome).toBeUndefined();
  });

  it("throws when a case names a trapField with no corresponding score, instead of silently skipping it", () => {
    expect(() => applyTrapFidelity(class2Case, emptyDraft(), [])).toThrow();
  });
});

describe("evaluateThreshold (task-12-review.md A7/m8)", () => {
  it("passes a scorecard that clears both the class-2 recall and coverage minimums", () => {
    expect(evaluateThreshold({ ...zeroScorecard(), class2TrapRecall: 1, coverage: 1 }).passed).toBe(true);
  });

  it("fails, and names the reason, when class-2 trap recall is below the minimum", () => {
    const result = evaluateThreshold({ ...zeroScorecard(), class2TrapRecall: 0, coverage: 1 });
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("class-2 trap recall"))).toBe(true);
  });

  it("fails, and names the reason, when coverage is below the minimum -- catches an all-blank model even with perfect recall", () => {
    const result = evaluateThreshold({ ...zeroScorecard(), class2TrapRecall: 1, coverage: 0 });
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("coverage"))).toBe(true);
  });

  it("the configured minimums are non-trivial (neither 0 nor 1)", () => {
    expect(EVAL_THRESHOLDS.class2TrapRecallMin).toBeGreaterThan(0);
    expect(EVAL_THRESHOLDS.class2TrapRecallMin).toBeLessThanOrEqual(1);
    expect(EVAL_THRESHOLDS.coverageMin).toBeGreaterThan(0);
  });
});

describe("EvalCaseSchema", () => {
  const baseCase = {
    id: "x",
    rawText: "y",
    expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 0 },
  };

  it("accepts passportNumber and travellerFullName as trap fields (task-12-review.md M4/A5 -- previously only destinationCountry/partnerName were representable)", () => {
    expect(() => EvalCaseSchema.parse({ ...baseCase, trapField: "passportNumber" })).not.toThrow();
    expect(() => EvalCaseSchema.parse({ ...baseCase, trapField: "travellerFullName" })).not.toThrow();
  });

  it("rejects a case that sets trapClass without a trapField", () => {
    expect(() => EvalCaseSchema.parse({ ...baseCase, trapClass: "resolves" })).toThrow();
  });
});

it("does not self-execute main() on import -- process.exitCode is untouched (task-12-review.md m7)", () => {
  // Before this round, `main()` ran unconditionally at module scope. Under
  // vitest there is no --provider flag and no LLM_PROVIDER in the
  // environment, so an unguarded main() would have its own .catch() set
  // process.exitCode = 1 as a side effect of merely importing this module --
  // corrupting the whole test run's exit code, not just failing an
  // assertion. By the time this test runs (after every test above, all of
  // which import the module at the top of the file), that side effect would
  // long since have happened if the guard were missing.
  expect(process.exitCode).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The five-strategy scorecard, reproduced through the real scoreCase/summarize
// ---------------------------------------------------------------------------

interface RawExtraction {
  travellerFullName: string;
  passportNumber: string;
  destinationCountryRaw: string;
  partnerNameRaw: string;
  applicantCount: number;
  missingDocuments: string[];
}

const COUNTRY_NAME_BY_CODE: Record<string, string> = {
  JP: "Japan",
  SG: "Singapore",
  TH: "Thailand",
  KE: "Kenya",
  GB: "United Kingdom",
  AE: "Dubai",
  LK: "Sri Lanka",
  FR: "France",
  CA: "Canada",
  DE: "Germany",
  MM: "Myanmar",
  LU: "Luxembourg",
};

/** Strategy A -- copies exactly what a correctly-behaving model should say:
 * the true value for every ordinary field, and for a trap field, the exact
 * raw text the trap names (or, for a passport-shaped non-passport, nothing
 * at all -- there is no resolution step to fall back on for that field). */
function deriveFaithfulExtraction(evalCase: EvalCase): RawExtraction {
  const travellerFullName =
    evalCase.trapField === "travellerFullName" ? "" : (evalCase.expected.travellerFullName ?? "");
  const passportNumber = evalCase.trapField === "passportNumber" ? "" : (evalCase.expected.passportNumber ?? "");
  const destinationCountryRaw =
    evalCase.trapField === "destinationCountry"
      ? (evalCase.trapRawText ?? "")
      : (COUNTRY_NAME_BY_CODE[evalCase.expected.destinationCountry ?? ""] ?? "");
  const partnerNameRaw =
    evalCase.trapField === "partnerName" ? (evalCase.trapRawText ?? "") : (evalCase.expected.partnerName ?? "");
  return {
    travellerFullName,
    passportNumber,
    destinationCountryRaw,
    partnerNameRaw,
    applicantCount: evalCase.expected.applicantCount,
    missingDocuments: [],
  };
}

/** Strategy B -- resolves every trap confidently, right or wrong. */
function deriveConfidentGuesserExtraction(evalCase: EvalCase): RawExtraction {
  const base = deriveFaithfulExtraction(evalCase);
  if (evalCase.trapField === "destinationCountry") {
    return { ...base, destinationCountryRaw: "Thailand" };
  }
  if (evalCase.trapField === "partnerName") {
    return { ...base, partnerNameRaw: "Confident Travels Ltd" };
  }
  if (evalCase.trapField === "passportNumber") {
    return { ...base, passportNumber: evalCase.trapRawText ?? base.passportNumber };
  }
  return base;
}

/** Strategy C -- correctly fixes the two unambiguous misspellings (the right
 * behaviour for Class 1), but "helpfully" invents a value for the Class 2
 * traps that are not a value at all. */
function deriveHelpfulCorrectorExtraction(evalCase: EvalCase): RawExtraction {
  const base = deriveFaithfulExtraction(evalCase);
  if (evalCase.trapField === "destinationCountry" && evalCase.trapClass === "resolves") {
    const corrected: Record<string, string> = { Myannmar: "Myanmar", Lexumbourg: "Luxembourg" };
    return { ...base, destinationCountryRaw: corrected[evalCase.trapRawText ?? ""] ?? base.destinationCountryRaw };
  }
  if (evalCase.trapField === "destinationCountry") {
    return { ...base, destinationCountryRaw: "India" }; // not in the country map either
  }
  if (evalCase.trapField === "partnerName") {
    return { ...base, partnerNameRaw: (evalCase.trapRawText ?? "").replace(/\s*A\/C$/, " Travels") };
  }
  if (evalCase.trapField === "passportNumber") {
    return { ...base, passportNumber: "2402026" }; // "tidies" the garbled digits into passport shape
  }
  return base;
}

/** Strategy D -- the all-blank sentinel for every case, every field. */
function deriveAllBlankExtraction(): RawExtraction {
  return {
    travellerFullName: "",
    passportNumber: "",
    destinationCountryRaw: "",
    partnerNameRaw: "",
    applicantCount: 0,
    missingDocuments: [],
  };
}

/** Strategy E -- dumps the entire input back into every field. */
function deriveEchoExtraction(evalCase: EvalCase): RawExtraction {
  return {
    travellerFullName: evalCase.rawText,
    passportNumber: evalCase.rawText,
    destinationCountryRaw: evalCase.rawText,
    partnerNameRaw: evalCase.rawText,
    applicantCount: 0,
    missingDocuments: [],
  };
}

async function runStrategy(
  cases: EvalCase[],
  deriveExtraction: (evalCase: EvalCase) => RawExtraction,
): Promise<{ scorecard: ProviderScorecard; caseResults: CaseResult[] }> {
  const scriptedTurns: ScriptedTurn[] = cases.map((evalCase) => ({
    text: JSON.stringify(deriveExtraction(evalCase)),
    toolCalls: [],
  }));
  const context = buildEvalContext(new FakeLlmProvider(scriptedTurns));
  await seedFixtures(context, cases);

  const caseResults: CaseResult[] = [];
  for (const evalCase of cases) {
    caseResults.push(await scoreCase(context, evalCase));
  }
  return { scorecard: summarize(caseResults), caseResults };
}

describe("the five-strategy scorecard (task-12-review.md A3/M2 -- the review's own methodology, reused as a test)", () => {
  it("loads the real eval case file, and it validates against the (widened) schema", async () => {
    const cases = await loadRealCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("A. a faithful, verbatim-copying model scores perfectly: 100% accuracy, 0% hallucination, both trap classes at 100%, and passes the threshold", async () => {
    const cases = await loadRealCases();
    const { scorecard } = await runStrategy(cases, deriveFaithfulExtraction);

    expect(scorecard.exactFieldAccuracy).toBe(1);
    expect(scorecard.hallucinationRate).toBe(0);
    expect(scorecard.class1TrapAccuracy).toBe(1);
    expect(scorecard.class2TrapRecall).toBe(1);
    expect(scorecard.class1TrapsTotal).toBe(2); // Myannmar, Lexumbourg
    expect(scorecard.class2TrapsTotal).toBeGreaterThanOrEqual(7);
    expect(evaluateThreshold(scorecard).passed).toBe(true);
  });

  it("B. a confident guesser that resolves every trap scores strictly worse than the faithful model on every headline number", async () => {
    const cases = await loadRealCases();
    const { scorecard: faithful } = await runStrategy(cases, deriveFaithfulExtraction);
    const { scorecard: guesser } = await runStrategy(cases, deriveConfidentGuesserExtraction);

    expect(guesser.exactFieldAccuracy).toBeLessThan(faithful.exactFieldAccuracy);
    expect(guesser.hallucinationRate).toBeGreaterThan(faithful.hallucinationRate);
    expect(guesser.class1TrapAccuracy).toBeLessThan(faithful.class1TrapAccuracy);
    expect(guesser.class2TrapRecall).toBeLessThan(faithful.class2TrapRecall);
    expect(guesser.class2TrapRecall).toBe(0);
    expect(evaluateThreshold(guesser).passed).toBe(false);
  });

  it("C1: a 'helpful' model that fabricates a value which ALSO fails to resolve is caught, not credited as declining", async () => {
    const cases = await loadRealCases();
    const { scorecard, caseResults } = await runStrategy(cases, deriveHelpfulCorrectorExtraction);

    // Correcting the two unambiguous misspellings IS the right answer.
    expect(scorecard.class1TrapAccuracy).toBe(1);

    // But inventing "India" for a service line, or "2402026" for a garbled
    // date, are fabrications -- even though neither resolves to a real
    // record -- and this is the exact C1 regression: before the fix,
    // `destinationCountry === null` alone made both indistinguishable from
    // an honest refusal.
    const passportNewCase = caseResults.find((caseResult) => caseResult.id === "trap-service-line-passport-new");
    expect(passportNewCase?.trapOutcome?.satisfied).toBe(false);
    expect(passportNewCase?.trapOutcome?.fabricatedRaw).toBe(true);

    const passportTrapCase = caseResults.find((caseResult) => caseResult.id === "trap-passport-garbled-date");
    expect(passportTrapCase?.trapOutcome?.satisfied).toBe(false);

    expect(scorecard.class2TrapRecall).toBeLessThan(1);
    expect(scorecard.hallucinationRate).toBeGreaterThan(0);
  });

  it("D. a degenerate all-blank model has perfect hallucination/recall numbers, but zero coverage exposes it and fails the threshold", async () => {
    const cases = await loadRealCases();
    const { scorecard } = await runStrategy(cases, deriveAllBlankExtraction);

    // task-12-review.md M3/A4: this is the exact trap the old scorecard had
    // -- two of the three old headline numbers are optimal for silence.
    expect(scorecard.hallucinationRate).toBe(0);
    expect(scorecard.class2TrapRecall).toBe(1);
    // It never resolves Myannmar/Lexumbourg either -- silence is not
    // correctness for a Class 1 trap.
    expect(scorecard.class1TrapAccuracy).toBe(0);

    expect(scorecard.coverage).toBe(0);
    expect(scorecard.exactFieldAccuracy).toBeLessThan(1);

    const threshold = evaluateThreshold(scorecard);
    expect(threshold.passed).toBe(false);
    expect(threshold.failedChecks.some((check) => check.includes("coverage"))).toBe(true);
  });

  it("E. a degenerate echo model has high coverage but is otherwise useless", async () => {
    const cases = await loadRealCases();
    const { scorecard } = await runStrategy(cases, deriveEchoExtraction);

    expect(scorecard.coverage).toBeGreaterThan(0.9);
    expect(scorecard.exactFieldAccuracy).toBeLessThan(0.5);
    expect(scorecard.hallucinationRate).toBeGreaterThan(0);
    expect(evaluateThreshold(scorecard).passed).toBe(false);
  });
});
