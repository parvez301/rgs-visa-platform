import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  applyTrapFidelity,
  assertProviderMatches,
  buildEvalContext,
  COUNTRY_NAME_BY_CODE,
  deriveCoverageThreshold,
  deriveFaithfulExtraction,
  EVAL_THRESHOLDS,
  EvalCaseSchema,
  evaluateThreshold,
  formatPreSpendBanner,
  printPreSpendBanner,
  rawTrapValue,
  scoreCase,
  scoreStringField,
  scoreTravellerResolution,
  seedFixtures,
  summarize,
  wasFieldAttempted,
  type CaseResult,
  type CoverageThreshold,
  type EvalCase,
  type ProviderScorecard,
  type RawExtraction,
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

  // task-12-fix-2-brief.md A2/D1: `fabricatedRaw` used to require
  // `actual === null`, which is unsatisfiable for passportNumber /
  // travellerFullName -- rawTrapValue reads the exact same field
  // FieldScore.actual does for those, so `actual === null && rawValue !==
  // undefined` could never both hold. The consequence: a model honestly
  // copying the source text verbatim into the wrong field scored identically
  // to one inventing a value with no relation to the source at all. This is
  // the mutation the brief names directly: "make the honest copier and the
  // inventor produce the same output; a test must distinguish them."
  describe("D1 fix: distinguishes an honest verbatim copy from an outright invention on a single-tier field", () => {
    const passportTrapCase: EvalCase = {
      id: "t-passport-trap",
      rawText: "irrelevant",
      trapField: "passportNumber",
      trapRawText: "24-02-026",
      expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 1 },
    };

    it("an honest copy of the source text is NOT flagged as fabricated, even though it is still the wrong field to have filled", () => {
      const result = applyTrapFidelity(
        passportTrapCase,
        emptyDraft({ passportNumber: "24-02-026" }),
        [scoreStringField("passportNumber", null, "24-02-026")],
      );
      expect(result.trapOutcome?.satisfied).toBe(false);
      expect(result.trapOutcome?.fabricatedRaw).toBe(false);
    });

    it("a value with no relation to the source text at all IS flagged as fabricated", () => {
      const result = applyTrapFidelity(
        passportTrapCase,
        emptyDraft({ passportNumber: "Z9999999" }),
        [scoreStringField("passportNumber", null, "Z9999999")],
      );
      expect(result.trapOutcome?.satisfied).toBe(false);
      expect(result.trapOutcome?.fabricatedRaw).toBe(true);
    });

    it("the two are distinguishable -- before the fix both were fabricatedRaw: false, indistinguishable from each other", () => {
      const honestCopy = applyTrapFidelity(
        passportTrapCase,
        emptyDraft({ passportNumber: "24-02-026" }),
        [scoreStringField("passportNumber", null, "24-02-026")],
      );
      const invention = applyTrapFidelity(
        passportTrapCase,
        emptyDraft({ passportNumber: "Z9999999" }),
        [scoreStringField("passportNumber", null, "Z9999999")],
      );
      expect(honestCopy.trapOutcome?.fabricatedRaw).not.toBe(invention.trapOutcome?.fabricatedRaw);
    });

    it("an honest, full decline (field left blank) is still satisfied, unaffected by the fix", () => {
      const result = applyTrapFidelity(passportTrapCase, emptyDraft(), [
        scoreStringField("passportNumber", null, null),
      ]);
      expect(result.trapOutcome?.satisfied).toBe(true);
      expect(result.trapOutcome?.fabricatedRaw).toBe(false);
    });
  });
});

// A literal fixture, deliberately NOT derived from the real case file -- these
// tests exercise evaluateThreshold's own gating logic in isolation, so the
// coverage numbers just need to be self-consistent, not measured.
const FIXED_COVERAGE_THRESHOLD: CoverageThreshold = { coverageMin: 0.5, perfectModelCoverageCeiling: 0.9 };

describe("evaluateThreshold (task-12-review.md A7/m8, task-12-fix-2-brief.md A5/A6)", () => {
  it("passes a scorecard that clears the class-2 recall, class-1 accuracy and coverage minimums", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 1, class1TrapAccuracy: 1, coverage: 1 };
    expect(evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD).passed).toBe(true);
  });

  it("fails, and names the reason, when class-2 trap recall is below the minimum", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 0, class1TrapAccuracy: 1, coverage: 1 };
    const result = evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("class-2 trap recall"))).toBe(true);
  });

  // task-12-fix-3-brief.md A1: P69's exact scenario -- eight of nine class-2
  // traps satisfied, one fabricated. Every fixture above this one sets
  // class2TrapRecall to 0 or 1, never to a value between them, so the gate's
  // actual cut-point (>= 1.0, not merely "> 0") was unpinned: a mutation
  // relaxing `< EVAL_THRESHOLDS.class2TrapRecallMin` to `< 0.75` left every
  // test above green (8/9 = 0.888..., and 0/1 vs 1/1 never probe that range)
  // while admitting exactly the fabricating provider P69 raised the
  // threshold to reject.
  it("fails on 8 of 9 class-2 traps satisfied (P69's exact scenario) -- the recall gate rejects anything short of all nine, not just total failure", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 8 / 9, class1TrapAccuracy: 1, coverage: 1 };
    const result = evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("class-2 trap recall"))).toBe(true);
  });

  // task-12-fix-2-brief.md A6/D5: the gate used to ignore class-1 accuracy
  // entirely -- a model that declines every unambiguous misspelling passed
  // identically to one that resolves them all. A worse outcome (no
  // destination at all) must not pass silently.
  it("fails, and names the reason, when class-1 trap accuracy is below the minimum -- a decliner must not pass identically to a resolver", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 1, class1TrapAccuracy: 0, coverage: 1 };
    const result = evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("class-1 trap accuracy"))).toBe(true);
  });

  // task-12-fix-3-brief.md A2: a class-1 accuracy strictly between 0 and 1,
  // inside the range a mutated `< 0.5` cut-point would still wrongly admit
  // (0.9 is not < 0.5), so this fixture requires the gate to actually hold
  // at its pinned 1.0 minimum rather than merely somewhere above 0.5.
  it("fails on class-1 trap accuracy of 0.9 -- strictly short of the pinned 1.0 minimum, not just total failure", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 1, class1TrapAccuracy: 0.9, coverage: 1 };
    const result = evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("class-1 trap accuracy"))).toBe(true);
  });

  it("fails, and names the reason, when coverage is below the minimum -- catches an all-blank model even with perfect recall", () => {
    const scorecard = { ...zeroScorecard(), class2TrapRecall: 1, class1TrapAccuracy: 1, coverage: 0 };
    const result = evaluateThreshold(scorecard, FIXED_COVERAGE_THRESHOLD);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("coverage"))).toBe(true);
  });

  // task-12-fix-2-brief.md A5, ruled with the reviewer: a false FAIL costs a
  // free re-run; a false PASS costs exactly the failure this task exists to
  // prevent. Both non-coverage minimums are pinned at exactly 1.0, not just
  // "non-trivial" -- the old 0.75 let a provider fabricating on two of nine
  // class-2 traps still pass.
  it("class-2 trap recall and class-1 trap accuracy are both pinned at exactly 1.0", () => {
    expect(EVAL_THRESHOLDS.class2TrapRecallMin).toBe(1.0);
    expect(EVAL_THRESHOLDS.class1TrapAccuracyMin).toBe(1.0);
  });
});

describe("EvalCaseSchema", () => {
  const baseCase = {
    id: "x",
    rawText: "y",
    expected: { travellerFullName: null, passportNumber: null, destinationCountry: null, partnerName: null, applicantCount: 0 },
  };

  it("accepts passportNumber and travellerFullName as trap fields (task-12-review.md M4/A5 -- previously only destinationCountry/partnerName were representable)", () => {
    expect(() =>
      EvalCaseSchema.parse({ ...baseCase, trapField: "passportNumber", trapRawText: "24-02-026" }),
    ).not.toThrow();
    expect(() =>
      EvalCaseSchema.parse({ ...baseCase, trapField: "travellerFullName", trapRawText: "Some Name" }),
    ).not.toThrow();
  });

  it("rejects a case that sets trapClass without a trapField", () => {
    expect(() => EvalCaseSchema.parse({ ...baseCase, trapClass: "resolves" })).toThrow();
  });

  // task-12-fix-2-brief.md A4: omitting trapRawText used to survive parsing
  // silently and disable applyTrapFidelity's raw-value check for that case
  // entirely (it gates on `evalCase.trapRawText !== undefined`) -- the trap
  // quietly stopped being scored as one, at 607/607.
  it("rejects a case that sets trapField without trapRawText", () => {
    expect(() => EvalCaseSchema.parse({ ...baseCase, trapField: "destinationCountry" })).toThrow();
  });

  it("accepts a case that sets both trapField and trapRawText together", () => {
    expect(() =>
      EvalCaseSchema.parse({ ...baseCase, trapField: "destinationCountry", trapRawText: "PASSPORT NEW" }),
    ).not.toThrow();
  });
});

describe("rawTrapValue", () => {
  it("reads the unresolved carrier for a two-tier field (destinationCountry/partnerName)", () => {
    expect(rawTrapValue(emptyDraft({ unresolvedCountry: "PASSPORT NEW" }), "destinationCountry")).toBe(
      "PASSPORT NEW",
    );
    expect(rawTrapValue(emptyDraft({ unresolvedPartnerName: "SAMMY A/C" }), "partnerName")).toBe("SAMMY A/C");
  });

  it("is undefined for a two-tier field that resolved instead (no raw carrier populated)", () => {
    expect(rawTrapValue(emptyDraft({ destinationCountry: "TH" }), "destinationCountry")).toBeUndefined();
  });

  it("reads the field itself for a single-tier field (passportNumber/travellerFullName) -- there is no separate carrier", () => {
    expect(rawTrapValue(emptyDraft({ passportNumber: "24-02-026" }), "passportNumber")).toBe("24-02-026");
    expect(rawTrapValue(emptyDraft({ travellerFullName: "Ritu Bansal" }), "travellerFullName")).toBe(
      "Ritu Bansal",
    );
  });
});

// task-12-fix-2-brief.md A3: extracted out of unexported main(), where before
// this round no test could reach either the mismatch gate or the pre-spend
// banner -- both survived at 607/607 despite the review's own mutation
// testing.
describe("assertProviderMatches (task-12-fix-2-brief.md A3)", () => {
  it("throws when the CLI --provider flag disagrees with the configured LLM_PROVIDER", () => {
    expect(() => assertProviderMatches("anthropic", "gemini")).toThrow(/does not match/);
  });

  it("does not throw when they agree", () => {
    expect(() => assertProviderMatches("gemini", "gemini")).not.toThrow();
  });
});

describe("formatPreSpendBanner / printPreSpendBanner (task-12-fix-2-brief.md A3)", () => {
  it("names the provider, the model and the case count, and warns about cost", () => {
    const lines = formatPreSpendBanner("anthropic", "claude-x", 24);
    expect(lines.some((line) => line.includes("provider=anthropic"))).toBe(true);
    expect(lines.some((line) => line.includes("model=claude-x"))).toBe(true);
    expect(lines.some((line) => line.includes("cases=24"))).toBe(true);
    expect(lines.some((line) => /incur cost/i.test(line))).toBe(true);
  });

  it("prints the banner AND waits before resolving -- a mutation deleting the countdown must not make this resolve immediately", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let resolved = false;

    const bannerPromise = printPreSpendBanner("gemini", "gemini-x", 3, 3000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false); // the countdown has not elapsed yet
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("provider=gemini"))).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    await bannerPromise;
    expect(resolved).toBe(true);

    logSpy.mockRestore();
    vi.useRealTimers();
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

// RawExtraction, COUNTRY_NAME_BY_CODE and deriveFaithfulExtraction (Strategy
// A) now live in runIntakeEval.ts itself (task-12-fix-2-brief.md A5): the
// production script self-simulates a perfect model offline to derive its own
// coverage floor, and imports them here rather than keeping a second,
// independently-drifting copy of "what does a perfect model say".

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
    const coverageThreshold = await deriveCoverageThreshold(cases);
    const { scorecard } = await runStrategy(cases, deriveFaithfulExtraction);

    expect(scorecard.exactFieldAccuracy).toBe(1);
    expect(scorecard.hallucinationRate).toBe(0);
    expect(scorecard.class1TrapAccuracy).toBe(1);
    expect(scorecard.class2TrapRecall).toBe(1);
    expect(scorecard.class1TrapsTotal).toBe(2); // Myannmar, Lexumbourg
    // task-12-fix-2-brief.md A2-residue: pinned exactly, not floor-asserted
    // -- a case silently dropping out of the class-2 bucket (a missing
    // trapField/trapRawText, or a stray relabel to Class 1) must be caught
    // here even though every other assertion in this test would still pass.
    expect(scorecard.class2TrapsTotal).toBe(9);
    // A faithful model also reaches exactly the coverage ceiling the
    // threshold itself was derived from -- the two numbers must agree.
    expect(scorecard.coverage).toBeCloseTo(coverageThreshold.perfectModelCoverageCeiling, 10);
    expect(evaluateThreshold(scorecard, coverageThreshold).passed).toBe(true);
  });

  it("B. a confident guesser that resolves every trap scores strictly worse than the faithful model on every headline number", async () => {
    const cases = await loadRealCases();
    const coverageThreshold = await deriveCoverageThreshold(cases);
    const { scorecard: faithful } = await runStrategy(cases, deriveFaithfulExtraction);
    const { scorecard: guesser, caseResults } = await runStrategy(cases, deriveConfidentGuesserExtraction);

    expect(guesser.exactFieldAccuracy).toBeLessThan(faithful.exactFieldAccuracy);
    expect(guesser.hallucinationRate).toBeGreaterThan(faithful.hallucinationRate);
    expect(guesser.class1TrapAccuracy).toBeLessThan(faithful.class1TrapAccuracy);
    expect(guesser.class2TrapRecall).toBeLessThan(faithful.class2TrapRecall);
    expect(guesser.class2TrapRecall).toBe(0);
    expect(evaluateThreshold(guesser, coverageThreshold).passed).toBe(false);

    // task-12-fix-2-brief.md A2/D1: the guesser copies the trap's own raw
    // text verbatim into passportNumber (an honest, if wrongly-labelled,
    // extraction) -- it must NOT be flagged as a fabrication, even though it
    // is still an unsatisfied trap.
    const passportTrapCase = caseResults.find((caseResult) => caseResult.id === "trap-passport-garbled-date");
    expect(passportTrapCase?.trapOutcome?.satisfied).toBe(false);
    expect(passportTrapCase?.trapOutcome?.fabricatedRaw).toBe(false);
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

    // task-12-fix-2-brief.md A2/D1: "2402026" (the corrector's "tidied"
    // digits) does not match the case's own raw text "24-02-026" even under
    // buildLookupKey normalization (which does not strip punctuation) -- an
    // invented cleanup, not a verbatim copy, and it must now be flagged as
    // fabricated. Before the fix this was structurally impossible: the same
    // field read for both `actual` and the raw value made the check
    // unsatisfiable regardless of what the model produced.
    const passportTrapCase = caseResults.find((caseResult) => caseResult.id === "trap-passport-garbled-date");
    expect(passportTrapCase?.trapOutcome?.satisfied).toBe(false);
    expect(passportTrapCase?.trapOutcome?.fabricatedRaw).toBe(true);

    expect(scorecard.class2TrapRecall).toBeLessThan(1);
    expect(scorecard.hallucinationRate).toBeGreaterThan(0);
  });

  it("D. a degenerate all-blank model has perfect hallucination/recall numbers, but zero coverage exposes it and fails the threshold", async () => {
    const cases = await loadRealCases();
    const coverageThreshold = await deriveCoverageThreshold(cases);
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

    const threshold = evaluateThreshold(scorecard, coverageThreshold);
    expect(threshold.passed).toBe(false);
    // With class-1 accuracy now gated too (A6), an all-blank model fails on
    // BOTH grounds -- coverage must still be named among them.
    expect(threshold.failedChecks.some((check) => check.includes("coverage"))).toBe(true);
    expect(threshold.failedChecks.some((check) => check.includes("class-1 trap accuracy"))).toBe(true);
  });

  it("E. a degenerate echo model has high coverage but is otherwise useless", async () => {
    const cases = await loadRealCases();
    const coverageThreshold = await deriveCoverageThreshold(cases);
    const { scorecard } = await runStrategy(cases, deriveEchoExtraction);

    expect(scorecard.coverage).toBeGreaterThan(0.9);
    expect(scorecard.exactFieldAccuracy).toBeLessThan(0.5);
    expect(scorecard.hallucinationRate).toBeGreaterThan(0);
    expect(evaluateThreshold(scorecard, coverageThreshold).passed).toBe(false);
  });
});

describe("deriveCoverageThreshold (task-12-fix-2-brief.md A5)", () => {
  it("derives a coverage floor strictly below the perfect-model ceiling, and the ceiling is itself below 100% (some fields a correct model must leave blank)", async () => {
    const cases = await loadRealCases();
    const coverageThreshold = await deriveCoverageThreshold(cases);

    expect(coverageThreshold.perfectModelCoverageCeiling).toBeGreaterThan(0);
    expect(coverageThreshold.perfectModelCoverageCeiling).toBeLessThan(1);
    expect(coverageThreshold.coverageMin).toBeGreaterThan(0);
    expect(coverageThreshold.coverageMin).toBeLessThan(coverageThreshold.perfectModelCoverageCeiling);
  });

  // task-12-fix-3-brief.md A3: the block above only pins that coverageMin
  // sits SOMEWHERE strictly between 0 and the ceiling -- it never observes
  // WHERE. A mutation changing the derivation factor from 0.8 to 0.1 (an
  // almost-entirely-blank model would then clear the floor) left that
  // fixture, and the rest of the suite, at 0 red. This pins the actual
  // cut-point through the real evaluateThreshold gate a purchasing decision
  // uses -- not a copy of the 0.8 literal out of deriveCoverageThreshold,
  // which would just mirror the implementation rather than pin its
  // consequence -- so a model covering as little as 79% of what a perfect
  // model reaches must fail, and one covering 81% of it must pass.
  it("the coverage floor sits at 80% of the perfect-model ceiling -- 79% of it fails, exactly the ceiling and 81% of it both pass", async () => {
    const cases = await loadRealCases();
    const coverageThreshold = await deriveCoverageThreshold(cases);
    const { perfectModelCoverageCeiling } = coverageThreshold;

    const passesAtCoverage = (coverage: number): boolean =>
      evaluateThreshold(
        { ...zeroScorecard(), class2TrapRecall: 1, class1TrapAccuracy: 1, coverage },
        coverageThreshold,
      ).passed;

    expect(passesAtCoverage(perfectModelCoverageCeiling)).toBe(true);
    expect(passesAtCoverage(perfectModelCoverageCeiling * 0.79)).toBe(false);
    expect(passesAtCoverage(perfectModelCoverageCeiling * 0.81)).toBe(true);
  });
});
