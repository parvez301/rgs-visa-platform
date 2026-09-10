import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { crm } from "@rgs/shared";
import { extractIntake, type IntakeDraft } from "../src/agent/intake";
import { llmProviderConfigFromEnvironment } from "../src/agent/providers/config";
import { createLlmProvider } from "../src/agent/providers/index";
import type { AppContext } from "../src/lib/context";
import { InMemoryTableClient } from "../src/lib/db";
import { InMemoryDocumentStore } from "../src/lib/documentStore";
import { InMemoryEmailSender } from "../src/lib/email";
import { createPartner, getPartnerOrThrow } from "../src/domain/crm/partners";
import { upsertTraveller } from "../src/domain/crm/travellers";

/**
 * The eval that decides which LLM provider RGS can afford to run intake on
 * (task-12-brief.md Step 4/5, task-12-controller-notes.md §2/§4).
 *
 * THIS SCRIPT CALLS A LIVE PROVIDER AND COSTS REAL MONEY. It must never run
 * under `pnpm test`: it lives outside `src/` and `test/`, its filename has no
 * `.test.`/`.spec.` segment (vitest's default include pattern never matches
 * it), and it refuses to run at all without LLM_PROVIDER / LLM_MODEL /
 * LLM_API_KEY explicitly set in the environment (llmProviderConfigFromEnv-
 * ironment throws otherwise) plus a `--provider` flag that must agree with
 * LLM_PROVIDER -- a deliberate second gate against running against the wrong
 * vendor's key by mistake, given the whole point is a same-money comparison.
 *
 * Everything this module exports below `main` is exported so a
 * `FakeLlmProvider`-driven test can pin the scoring itself (task-12-
 * review.md M2/m7): before this round, `main()` ran unconditionally at
 * module scope with zero exports, so the code that will justify a purchasing
 * decision could not be imported by a test without spending money running it.
 *
 * Usage:
 *   LLM_PROVIDER=anthropic LLM_MODEL=<model id> LLM_API_KEY=<key> \
 *     pnpm --filter @rgs/api exec tsx eval/runIntakeEval.ts --provider anthropic
 *
 *   LLM_PROVIDER=gemini LLM_MODEL=<model id> LLM_API_KEY=<key> \
 *     pnpm --filter @rgs/api exec tsx eval/runIntakeEval.ts --provider gemini
 */

const TENANT_ID = "rgs";
/** Attributed to nobody real -- this context makes no write extractIntake would need an actor for. */
const EVAL_ACTOR_EMAIL = "intake-eval@rgs.local";

const EvalCaseExpectedSchema = z.object({
  travellerFullName: z.string().nullable(),
  passportNumber: z.string().nullable(),
  destinationCountry: z.string().nullable(),
  partnerName: z.string().nullable(),
  applicantCount: z.number().int().nonnegative(),
});

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    rawText: z.string().min(1),
    // Extensions beyond task-12-brief.md's literal "{ id, rawText, expected }"
    // shape -- additive, not a replacement of it. trapKind documents which
    // measured row of docs/migration-questions-for-rgs.md a case exercises;
    // trapField names which single field is under test for a formal trap
    // case (a case can have other null-expected fields that are merely "not
    // mentioned", not the trap under test).
    trapKind: z.string().optional(),
    // Widened beyond {destinationCountry, partnerName} (task-12-review.md
    // M4/A5): those two are the fields the IMPLEMENTATION resolves, but
    // passportNumber and travellerFullName are copied straight from the
    // model with no resolution step of their own, and the spec's own
    // headline failure ("a model that misreads a passport number") can only
    // be represented on one of them.
    trapField: z.enum(["destinationCountry", "partnerName", "passportNumber", "travellerFullName"]).optional(),
    // task-12-review.md A2: controller-notes §2 said every trap's correct
    // answer is "stays unresolved" -- true for most, wrong for two.
    // "resolves" (Myannmar, Lexumbourg): an unambiguous misspelling of a
    // real value; the RIGHT answer is resolving it, same as a desk agent
    // would. "unresolved" (the default): not a value at all, or more than
    // one; any resolution is a fabrication.
    trapClass: z.enum(["unresolved", "resolves"]).optional(),
    // task-12-review.md C1: the exact substring of `rawText` a faithful,
    // non-fabricating extraction must carry into the raw (pre-resolution)
    // field when trapField is a "unresolved"-class trap on destinationCountry
    // or partnerName. Compared via buildLookupKey normalization (case- and
    // whitespace-insensitive), not literal string equality -- without this,
    // "the model declined" and "the model invented a value the map also
    // happens not to know" were the same observation to the scorer.
    trapRawText: z.string().optional(),
    seed: z
      .object({
        traveller: z.object({ fullName: z.string(), passportNumber: z.string() }).optional(),
        partner: z.object({ canonicalName: z.string() }).optional(),
      })
      .optional(),
    expected: EvalCaseExpectedSchema,
  })
  .refine((evalCase) => evalCase.trapClass === undefined || evalCase.trapField !== undefined, {
    message: "trapClass requires trapField to be set",
  });
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const SCORED_STRING_FIELDS = [
  "travellerFullName",
  "passportNumber",
  "destinationCountry",
  "partnerName",
] as const;
export type ScoredStringField = (typeof SCORED_STRING_FIELDS)[number];

export interface FieldScore {
  field: ScoredStringField | "applicantCount" | "travellerResolution";
  expected: string | number | null;
  actual: string | number | null;
  correct: boolean;
  /** Only meaningful for a field whose expected value is null -- did the
   * pipeline invent something anyway? Never set for applicantCount: a wrong
   * headcount is a miscount, not "a field the input did not contain". */
  hallucinated: boolean;
}

/** What a trap-labelled case's own field resolved to, after C1's raw-value
 * fidelity check. `satisfied` is what feeds class1TrapAccuracy /
 * class2TrapRecall; `fabricatedRaw` is true only for an "unresolved" trap
 * whose field correctly stayed unresolved on the surface, but whose raw
 * extracted text does not match what the source actually said. */
export interface TrapOutcome {
  field: NonNullable<EvalCase["trapField"]>;
  trapClass: "unresolved" | "resolves";
  satisfied: boolean;
  fabricatedRaw: boolean;
}

export interface CaseResult {
  id: string;
  trapKind: string | undefined;
  trapField: EvalCase["trapField"];
  trapClass: "unresolved" | "resolves" | undefined;
  rawText: string;
  draft: IntakeDraft;
  fieldScores: FieldScore[];
  trapOutcome: TrapOutcome | undefined;
}

/** Case-insensitive, whitespace- and word-order-tolerant: "Ashok Kumar",
 * "ashok kumar" and an MRZ-order "Kumar Ashok" all count as the same name.
 * Only used for the two free-text name fields -- passportNumber and
 * destinationCountry are compared as exact codes, not names. */
export function namesMatch(expectedName: string, actualName: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0).sort().join(" ");
  return normalize(expectedName) === normalize(actualName);
}

export function codesMatch(expectedCode: string, actualCode: string): boolean {
  return expectedCode.trim().toUpperCase() === actualCode.trim().toUpperCase();
}

export function scoreStringField(
  field: ScoredStringField,
  expected: string | null,
  actual: string | null,
): FieldScore {
  const comparator = field === "travellerFullName" || field === "partnerName" ? namesMatch : codesMatch;
  const correct =
    expected === null ? actual === null : actual !== null && comparator(expected, actual);
  return { field, expected, actual, correct, hallucinated: expected === null && actual !== null };
}

/** task-12-review.md m2: traveller resolution (`draft.applicants`) was never
 * scored -- only partner resolution was. A case that seeds a traveller under
 * exactly the passport its `expected.passportNumber` states should see that
 * traveller attached; every other case should see none attached at all. A
 * build that deleted the `findTravellerByPassport` call entirely used to
 * score 100% on this eval; it no longer does. */
export function scoreTravellerResolution(evalCase: EvalCase, draft: IntakeDraft): FieldScore {
  const seededPassport = evalCase.seed?.traveller?.passportNumber;
  const shouldResolve = seededPassport !== undefined && seededPassport === evalCase.expected.passportNumber;
  const actualPassport = draft.applicants.length === 0 ? null : (draft.applicants[0]?.passportNumber ?? null);
  const correct = shouldResolve
    ? draft.applicants.length === 1 && actualPassport === seededPassport
    : draft.applicants.length === 0;

  return {
    field: "travellerResolution",
    expected: shouldResolve ? (seededPassport ?? null) : null,
    actual: actualPassport,
    correct,
    hallucinated: !shouldResolve && draft.applicants.length > 0,
  };
}

export async function resolvedPartnerName(context: AppContext, draft: IntakeDraft): Promise<string | null> {
  if (draft.partnerId === undefined) return null;
  // The partner store is the single source of truth for what a resolved
  // partnerId is actually called -- extractIntake itself never carries a
  // partner's name past resolution, on purpose (it is a foreign key, not a
  // guess), so scoring has to look the id back up the same way any other
  // caller would.
  const partner = await getPartnerOrThrow(context, TENANT_ID, draft.partnerId);
  return partner.canonicalName;
}

/** The model's raw, pre-resolution value for a trap field -- what C1 requires
 * scoring against. destinationCountry/partnerName have a genuine two-tier
 * resolved/unresolved split on `IntakeDraft`; passportNumber/travellerFullName
 * do not (the draft carries them as-extracted either way), so the "raw value"
 * for those is simply the field itself. */
export function rawTrapValue(draft: IntakeDraft, field: NonNullable<EvalCase["trapField"]>): string | undefined {
  switch (field) {
    case "destinationCountry":
      return draft.unresolvedCountry;
    case "partnerName":
      return draft.unresolvedPartnerName;
    case "passportNumber":
      return draft.passportNumber;
    case "travellerFullName":
      return draft.travellerFullName;
  }
}

/** Whether the model produced ANY signal for this field -- a raw value that
 * later failed to resolve counts as "attempted", same as one that resolved
 * cleanly. Deliberately distinct from a FieldScore's post-resolution
 * `actual`: computing coverage off the resolved value would count a
 * correctly-declined Class 2 trap (destinationCountry stays undefined by
 * design) as "not filled", conflating "the model said nothing" with "the
 * model tried and the deterministic resolver correctly refused it" -- the
 * same conflation C1 already fixes for hallucination, and coverage must not
 * reintroduce it (task-12-review.md A4/M3). */
export function wasFieldAttempted(draft: IntakeDraft, field: ScoredStringField): boolean {
  switch (field) {
    case "travellerFullName":
      return draft.travellerFullName !== undefined;
    case "passportNumber":
      return draft.passportNumber !== undefined;
    case "destinationCountry":
      return draft.destinationCountry !== undefined || draft.unresolvedCountry !== undefined;
    case "partnerName":
      return draft.partnerId !== undefined || draft.unresolvedPartnerName !== undefined;
  }
}

/**
 * task-12-review.md C1 + A2. Judges whether a trap-labelled case's field was
 * handled correctly, and corrects the field's own FieldScore in place when a
 * "should stay unresolved" trap turns out to have been fed a fabricated raw
 * value -- which also means C1's fix flows straight into the pre-existing
 * `hallucinationRate` (any FieldScore with `expected === null` already feeds
 * it), not just into a new, separate number.
 */
export function applyTrapFidelity(
  evalCase: EvalCase,
  draft: IntakeDraft,
  fieldScores: FieldScore[],
): { fieldScores: FieldScore[]; trapOutcome: TrapOutcome | undefined } {
  if (evalCase.trapField === undefined) {
    return { fieldScores, trapOutcome: undefined };
  }
  const trapClass = evalCase.trapClass ?? "unresolved";
  const trapFieldIndex = fieldScores.findIndex((fieldScore) => fieldScore.field === evalCase.trapField);
  if (trapFieldIndex === -1) {
    throw new Error(`case ${evalCase.id} names trapField ${evalCase.trapField} but has no score for it`);
  }
  const trapFieldScore = fieldScores[trapFieldIndex];
  if (trapFieldScore === undefined) {
    throw new Error(`case ${evalCase.id} names trapField ${evalCase.trapField} but has no score for it`);
  }

  if (trapClass === "resolves") {
    // Class 1: correct behaviour IS resolving to the expected value -- the
    // ordinary post-resolution comparison already is the right test.
    return {
      fieldScores,
      trapOutcome: { field: evalCase.trapField, trapClass, satisfied: trapFieldScore.correct, fabricatedRaw: false },
    };
  }

  // Class 2 ("unresolved"): staying unresolved is necessary but not
  // sufficient. When the case states the exact substring a faithful copy
  // must carry, the model's raw output must match it -- up to
  // buildLookupKey normalization -- or this is a fabrication that merely
  // also failed to resolve.
  const rawValue = rawTrapValue(draft, evalCase.trapField);
  const fabricatedRaw =
    trapFieldScore.actual === null &&
    evalCase.trapRawText !== undefined &&
    rawValue !== undefined &&
    crm.buildLookupKey(rawValue) !== crm.buildLookupKey(evalCase.trapRawText);

  if (!fabricatedRaw) {
    return {
      fieldScores,
      trapOutcome: { field: evalCase.trapField, trapClass, satisfied: trapFieldScore.correct, fabricatedRaw: false },
    };
  }

  const adjustedFieldScores = fieldScores.map((fieldScore, index) =>
    index === trapFieldIndex ? { ...fieldScore, correct: false, hallucinated: true } : fieldScore,
  );
  return {
    fieldScores: adjustedFieldScores,
    trapOutcome: { field: evalCase.trapField, trapClass, satisfied: false, fabricatedRaw: true },
  };
}

export async function scoreCase(context: AppContext, evalCase: EvalCase): Promise<CaseResult> {
  const draft = await extractIntake(context, TENANT_ID, evalCase.rawText, EVAL_ACTOR_EMAIL);
  const actualPartnerName = await resolvedPartnerName(context, draft);

  const baseFieldScores: FieldScore[] = [
    scoreStringField("travellerFullName", evalCase.expected.travellerFullName, draft.travellerFullName ?? null),
    scoreStringField("passportNumber", evalCase.expected.passportNumber, draft.passportNumber ?? null),
    scoreStringField(
      "destinationCountry",
      evalCase.expected.destinationCountry,
      draft.destinationCountry ?? null,
    ),
    scoreStringField("partnerName", evalCase.expected.partnerName, actualPartnerName),
    {
      field: "applicantCount",
      expected: evalCase.expected.applicantCount,
      actual: draft.applicantCount,
      correct: evalCase.expected.applicantCount === draft.applicantCount,
      hallucinated: false,
    },
    scoreTravellerResolution(evalCase, draft),
  ];

  const { fieldScores, trapOutcome } = applyTrapFidelity(evalCase, draft, baseFieldScores);

  return {
    id: evalCase.id,
    trapKind: evalCase.trapKind,
    trapField: evalCase.trapField,
    trapClass: evalCase.trapField !== undefined ? (evalCase.trapClass ?? "unresolved") : undefined,
    rawText: evalCase.rawText,
    draft,
    fieldScores,
    trapOutcome,
  };
}

export interface ProviderScorecard {
  exactFieldAccuracy: number;
  fieldsScored: number;
  fieldsCorrect: number;
  hallucinationRate: number;
  hallucinationOpportunities: number;
  hallucinatedFields: number;
  /** task-12-review.md A4/M3: what fraction of the extractable string fields
   * (across every case, regardless of expected value) the model filled in at
   * all. A model that returns the all-blank sentinel for everything used to
   * take a perfect 0% hallucination rate and 100% unresolved-recall; this
   * number is 0% for exactly that model, so silence is visible rather than
   * rewarded. */
  coverage: number;
  fieldsFilled: number;
  fieldsFillable: number;
  /** Class 2 traps only (task-12-review.md A2): not a value at all, or more
   * than one -- any resolution is a fabrication. This is the number a
   * purchasing threshold should gate on (A7), not the blended accuracy. */
  class2TrapRecall: number;
  class2TrapsTotal: number;
  class2TrapsSatisfied: number;
  /** Class 1 traps only: an unambiguous misspelling of a real value --
   * correctly resolving it is the right answer, not a hallucination. */
  class1TrapAccuracy: number;
  class1TrapsTotal: number;
  class1TrapsSatisfied: number;
}

export function summarize(caseResults: CaseResult[]): ProviderScorecard {
  let fieldsScored = 0;
  let fieldsCorrect = 0;
  let hallucinationOpportunities = 0;
  let hallucinatedFields = 0;
  let stringFieldsScored = 0;
  let stringFieldsFilled = 0;

  for (const caseResult of caseResults) {
    for (const fieldScore of caseResult.fieldScores) {
      fieldsScored += 1;
      if (fieldScore.correct) fieldsCorrect += 1;
      if (fieldScore.expected === null && fieldScore.field !== "applicantCount") {
        hallucinationOpportunities += 1;
        if (fieldScore.hallucinated) hallucinatedFields += 1;
      }
    }
    for (const scoredStringField of SCORED_STRING_FIELDS) {
      stringFieldsScored += 1;
      if (wasFieldAttempted(caseResult.draft, scoredStringField)) stringFieldsFilled += 1;
    }
  }

  const trapOutcomes = caseResults
    .map((caseResult) => caseResult.trapOutcome)
    .filter((trapOutcome): trapOutcome is TrapOutcome => trapOutcome !== undefined);
  const class1Outcomes = trapOutcomes.filter((trapOutcome) => trapOutcome.trapClass === "resolves");
  const class2Outcomes = trapOutcomes.filter((trapOutcome) => trapOutcome.trapClass === "unresolved");
  const class1Satisfied = class1Outcomes.filter((trapOutcome) => trapOutcome.satisfied).length;
  const class2Satisfied = class2Outcomes.filter((trapOutcome) => trapOutcome.satisfied).length;

  return {
    exactFieldAccuracy: fieldsScored === 0 ? 0 : fieldsCorrect / fieldsScored,
    fieldsScored,
    fieldsCorrect,
    hallucinationRate: hallucinationOpportunities === 0 ? 0 : hallucinatedFields / hallucinationOpportunities,
    hallucinationOpportunities,
    hallucinatedFields,
    coverage: stringFieldsScored === 0 ? 0 : stringFieldsFilled / stringFieldsScored,
    fieldsFilled: stringFieldsFilled,
    fieldsFillable: stringFieldsScored,
    class2TrapRecall: class2Outcomes.length === 0 ? 0 : class2Satisfied / class2Outcomes.length,
    class2TrapsTotal: class2Outcomes.length,
    class2TrapsSatisfied: class2Satisfied,
    class1TrapAccuracy: class1Outcomes.length === 0 ? 0 : class1Satisfied / class1Outcomes.length,
    class1TrapsTotal: class1Outcomes.length,
    class1TrapsSatisfied: class1Satisfied,
  };
}

/** task-12-review.md A7/m8: there used to be no pass/fail threshold anywhere,
 * and `main()` always exited 0 -- a total guesser printed 92.7% accuracy (8
 * trap fields averaged against 102 easy ones) and nothing said so. Gated on
 * the class-2 numbers specifically, not the blended accuracy, per A7 -- plus
 * a coverage floor, because A4/M3's all-blank model would otherwise still
 * pass a class-2-only gate (it never guesses, so it never fails a class-2
 * trap either; coverage is what actually exposes it). */
export const EVAL_THRESHOLDS = {
  class2TrapRecallMin: 0.75,
  coverageMin: 0.5,
} as const;

export interface ThresholdResult {
  passed: boolean;
  failedChecks: string[];
}

export function evaluateThreshold(scorecard: ProviderScorecard): ThresholdResult {
  const failedChecks: string[] = [];
  if (scorecard.class2TrapRecall < EVAL_THRESHOLDS.class2TrapRecallMin) {
    failedChecks.push(
      `class-2 trap recall ${formatPercent(scorecard.class2TrapRecall)} is below the minimum ` +
        `${formatPercent(EVAL_THRESHOLDS.class2TrapRecallMin)}`,
    );
  }
  if (scorecard.coverage < EVAL_THRESHOLDS.coverageMin) {
    failedChecks.push(
      `coverage ${formatPercent(scorecard.coverage)} is below the minimum ${formatPercent(EVAL_THRESHOLDS.coverageMin)} ` +
        "-- a provider this silent cannot be judged safe just because it never guessed",
    );
  }
  return { passed: failedChecks.length === 0, failedChecks };
}

export function buildEvalContext(llmProvider: ReturnType<typeof createLlmProvider>): AppContext {
  return {
    table: new InMemoryTableClient(),
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date(),
    llm: llmProvider,
  };
}

/**
 * Seeds every fixture named in eval/intakeCases.json's `seed` blocks, once
 * per distinct passport / canonical name, into a single shared context. The
 * cases that name a fixture rely on it already being on file -- exactly the
 * repeat-traveller / known-partner situation the real desk is in most of the
 * time -- while every case that names none exercises the honest "nothing on
 * file yet" path.
 */
export async function seedFixtures(context: AppContext, cases: EvalCase[]): Promise<void> {
  const seededPassports = new Set<string>();
  const seededPartnerNames = new Set<string>();
  for (const evalCase of cases) {
    const travellerSeed = evalCase.seed?.traveller;
    if (travellerSeed !== undefined && !seededPassports.has(travellerSeed.passportNumber)) {
      await upsertTraveller(context, TENANT_ID, {
        fullName: travellerSeed.fullName,
        passportNumber: travellerSeed.passportNumber,
      });
      seededPassports.add(travellerSeed.passportNumber);
    }
    const partnerSeed = evalCase.seed?.partner;
    if (partnerSeed !== undefined && !seededPartnerNames.has(partnerSeed.canonicalName)) {
      await createPartner(
        context,
        TENANT_ID,
        { canonicalName: partnerSeed.canonicalName, partnerType: "AGENCY" },
        EVAL_ACTOR_EMAIL,
      );
      seededPartnerNames.add(partnerSeed.canonicalName);
    }
  }
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function printScorecard(providerName: string, model: string, scorecard: ProviderScorecard): void {
  console.log(`\nResults for ${providerName} (${model})`);
  console.table({
    "exact-field accuracy": {
      value: formatPercent(scorecard.exactFieldAccuracy),
      detail: `${scorecard.fieldsCorrect}/${scorecard.fieldsScored} fields`,
    },
    "hallucination rate": {
      value: formatPercent(scorecard.hallucinationRate),
      detail: `${scorecard.hallucinatedFields}/${scorecard.hallucinationOpportunities} null-expected fields invented`,
    },
    coverage: {
      value: formatPercent(scorecard.coverage),
      detail: `${scorecard.fieldsFilled}/${scorecard.fieldsFillable} extractable string fields filled in at all`,
    },
    "class-2 trap recall": {
      value: formatPercent(scorecard.class2TrapRecall),
      detail: `${scorecard.class2TrapsSatisfied}/${scorecard.class2TrapsTotal} not-a-value/multi-value traps correctly refused`,
    },
    "class-1 trap accuracy": {
      value: formatPercent(scorecard.class1TrapAccuracy),
      detail: `${scorecard.class1TrapsSatisfied}/${scorecard.class1TrapsTotal} unambiguous misspellings correctly resolved`,
    },
  });

  const threshold = evaluateThreshold(scorecard);
  console.log(
    `\nThreshold: class-2 trap recall >= ${formatPercent(EVAL_THRESHOLDS.class2TrapRecallMin)}, ` +
      `coverage >= ${formatPercent(EVAL_THRESHOLDS.coverageMin)}`,
  );
  console.log(threshold.passed ? "PASS" : `FAIL -- ${threshold.failedChecks.join("; ")}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { provider: { type: "string" } },
  });
  const requestedProvider = values.provider;
  if (requestedProvider !== "anthropic" && requestedProvider !== "gemini") {
    throw new Error('runIntakeEval.ts requires --provider anthropic|gemini');
  }

  // Model and key come from the environment (task-12-brief.md Step 4); the
  // CLI flag is a second, explicit confirmation of which vendor is about to
  // be billed, not an alternative source for it -- a mismatch is refused
  // rather than silently trusting whichever one the caller meant.
  const providerConfig = llmProviderConfigFromEnvironment(process.env);
  if (providerConfig.providerName !== requestedProvider) {
    throw new Error(
      `--provider ${requestedProvider} does not match LLM_PROVIDER=${providerConfig.providerName} in the ` +
        "environment -- refusing to run against a provider you did not ask for",
    );
  }

  const casesFileUrl = new URL("./intakeCases.json", import.meta.url);
  const rawCasesJson = JSON.parse(await readFile(casesFileUrl, "utf8"));
  const cases = z.array(EvalCaseSchema).parse(rawCasesJson);

  // notes §4: print the provider, the model and the case count BEFORE
  // starting, since every case from here on is a real, billed request.
  console.log(`intake eval: provider=${providerConfig.providerName} model=${providerConfig.model} cases=${cases.length}`);
  console.log("This calls a live provider and will incur cost. Starting in 3 seconds (Ctrl+C to abort)...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const llmProvider = createLlmProvider(providerConfig);
  const context = buildEvalContext(llmProvider);
  await seedFixtures(context, cases);

  const caseResults: CaseResult[] = [];
  for (const evalCase of cases) {
    console.log(`  running ${evalCase.id}...`);
    const caseResult = await scoreCase(context, evalCase);
    caseResults.push(caseResult);
  }

  const scorecard = summarize(caseResults);
  printScorecard(providerConfig.providerName, providerConfig.model, scorecard);
  const threshold = evaluateThreshold(scorecard);
  if (!threshold.passed) {
    // A7: this runner informs a purchasing decision -- a provider that
    // misses the bar must not report success just because nothing threw.
    process.exitCode = 1;
  }

  const failedTraps = caseResults.filter(
    (caseResult) => caseResult.trapOutcome !== undefined && !caseResult.trapOutcome.satisfied,
  );
  if (failedTraps.length > 0) {
    console.log("\nTrap cases the model failed:");
    for (const caseResult of failedTraps) {
      if (caseResult.trapField === undefined || caseResult.trapOutcome === undefined) continue;
      const trapScore = caseResult.fieldScores.find((fieldScore) => fieldScore.field === caseResult.trapField);
      if (caseResult.trapOutcome.fabricatedRaw) {
        const raw = rawTrapValue(caseResult.draft, caseResult.trapField);
        console.log(`  - ${caseResult.id}: ${caseResult.trapField} fabricated raw text "${raw}"`);
      } else if (caseResult.trapOutcome.trapClass === "resolves") {
        console.log(
          `  - ${caseResult.id}: ${caseResult.trapField} -> "${trapScore?.actual}" (expected "${trapScore?.expected}")`,
        );
      } else {
        console.log(`  - ${caseResult.id}: ${caseResult.trapField} -> "${trapScore?.actual}" (expected unresolved)`);
      }
    }
  }

  const isoDate = new Date().toISOString().slice(0, 10);
  const resultsFileUrl = new URL(`./results-${providerConfig.providerName}-${isoDate}.json`, import.meta.url);
  await writeFile(
    resultsFileUrl,
    JSON.stringify(
      {
        provider: providerConfig.providerName,
        model: providerConfig.model,
        generatedAt: new Date().toISOString(),
        caseCount: cases.length,
        scorecard,
        threshold,
        cases: caseResults,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nWrote ${resultsFileUrl.pathname}`);
}

// task-12-review.md m7: this used to call main() unconditionally at module
// scope, so any future `import` of this module -- a test, a tooling script
// -- ran the live-spending script. Guarded the same way Node's own docs
// recommend detecting "this file was run directly", so the exports above can
// be imported freely without ever calling main().
const isRunDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
