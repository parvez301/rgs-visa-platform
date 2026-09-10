import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
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

const EvalCaseSchema = z.object({
  id: z.string().min(1),
  rawText: z.string().min(1),
  // Extensions beyond task-12-brief.md's literal "{ id, rawText, expected }"
  // shape -- additive, not a replacement of it. trapKind documents which
  // measured row of docs/migration-questions-for-rgs.md a case exercises;
  // trapField names which single expected field must stay unresolved for a
  // formal trap case (a case can have other null-expected fields that are
  // merely "not mentioned", not the trap under test -- see
  // trap-multi-destination-tanzania-kenya and trap-partner-sammy-ac, each of
  // which resolves ONE field correctly while its trapField stays refused).
  trapKind: z.string().optional(),
  trapField: z.enum(["destinationCountry", "partnerName"]).optional(),
  seed: z
    .object({
      traveller: z.object({ fullName: z.string(), passportNumber: z.string() }).optional(),
      partner: z.object({ canonicalName: z.string() }).optional(),
    })
    .optional(),
  expected: EvalCaseExpectedSchema,
});
type EvalCase = z.infer<typeof EvalCaseSchema>;

const SCORED_STRING_FIELDS = ["travellerFullName", "passportNumber", "destinationCountry", "partnerName"] as const;
type ScoredStringField = (typeof SCORED_STRING_FIELDS)[number];

interface FieldScore {
  field: ScoredStringField | "applicantCount";
  expected: string | number | null;
  actual: string | number | null;
  correct: boolean;
  /** Only meaningful for a field whose expected value is null -- did the
   * pipeline invent something anyway? Never set for applicantCount: a wrong
   * headcount is a miscount, not "a field the input did not contain". */
  hallucinated: boolean;
}

interface CaseResult {
  id: string;
  trapKind: string | undefined;
  trapField: EvalCase["trapField"];
  rawText: string;
  draft: IntakeDraft;
  fieldScores: FieldScore[];
}

/** Case-insensitive, whitespace- and word-order-tolerant: "Ashok Kumar",
 * "ashok kumar" and an MRZ-order "Kumar Ashok" all count as the same name.
 * Only used for the two free-text name fields -- passportNumber and
 * destinationCountry are compared as exact codes, not names. */
function namesMatch(expectedName: string, actualName: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0).sort().join(" ");
  return normalize(expectedName) === normalize(actualName);
}

function codesMatch(expectedCode: string, actualCode: string): boolean {
  return expectedCode.trim().toUpperCase() === actualCode.trim().toUpperCase();
}

function scoreStringField(
  field: ScoredStringField,
  expected: string | null,
  actual: string | null,
): FieldScore {
  const comparator = field === "travellerFullName" || field === "partnerName" ? namesMatch : codesMatch;
  const correct =
    expected === null ? actual === null : actual !== null && comparator(expected, actual);
  return { field, expected, actual, correct, hallucinated: expected === null && actual !== null };
}

async function resolvedPartnerName(context: AppContext, draft: IntakeDraft): Promise<string | null> {
  if (draft.partnerId === undefined) return null;
  // The partner store is the single source of truth for what a resolved
  // partnerId is actually called -- extractIntake itself never carries a
  // partner's name past resolution, on purpose (it is a foreign key, not a
  // guess), so scoring has to look the id back up the same way any other
  // caller would.
  const partner = await getPartnerOrThrow(context, TENANT_ID, draft.partnerId);
  return partner.canonicalName;
}

async function scoreCase(context: AppContext, evalCase: EvalCase): Promise<CaseResult> {
  const draft = await extractIntake(context, TENANT_ID, evalCase.rawText, EVAL_ACTOR_EMAIL);
  const actualPartnerName = await resolvedPartnerName(context, draft);

  const fieldScores: FieldScore[] = [
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
  ];

  return { id: evalCase.id, trapKind: evalCase.trapKind, trapField: evalCase.trapField, rawText: evalCase.rawText, draft, fieldScores };
}

interface ProviderScorecard {
  exactFieldAccuracy: number;
  fieldsScored: number;
  fieldsCorrect: number;
  hallucinationRate: number;
  hallucinationOpportunities: number;
  hallucinatedFields: number;
  unresolvedRecall: number;
  trapFieldsTotal: number;
  trapFieldsCorrectlyUnresolved: number;
}

function summarize(caseResults: CaseResult[]): ProviderScorecard {
  let fieldsScored = 0;
  let fieldsCorrect = 0;
  let hallucinationOpportunities = 0;
  let hallucinatedFields = 0;

  for (const caseResult of caseResults) {
    for (const fieldScore of caseResult.fieldScores) {
      fieldsScored += 1;
      if (fieldScore.correct) fieldsCorrect += 1;
      if (fieldScore.expected === null && fieldScore.field !== "applicantCount") {
        hallucinationOpportunities += 1;
        if (fieldScore.hallucinated) hallucinatedFields += 1;
      }
    }
  }

  const trapFieldResults = caseResults
    .filter((caseResult) => caseResult.trapField !== undefined)
    .map((caseResult) => {
      const trapScore = caseResult.fieldScores.find((fieldScore) => fieldScore.field === caseResult.trapField);
      if (trapScore === undefined) {
        throw new Error(`case ${caseResult.id} names trapField ${caseResult.trapField} but has no score for it`);
      }
      return trapScore;
    });
  const trapFieldsCorrectlyUnresolved = trapFieldResults.filter((fieldScore) => fieldScore.correct).length;

  return {
    exactFieldAccuracy: fieldsScored === 0 ? 0 : fieldsCorrect / fieldsScored,
    fieldsScored,
    fieldsCorrect,
    hallucinationRate: hallucinationOpportunities === 0 ? 0 : hallucinatedFields / hallucinationOpportunities,
    hallucinationOpportunities,
    hallucinatedFields,
    unresolvedRecall: trapFieldResults.length === 0 ? 0 : trapFieldsCorrectlyUnresolved / trapFieldResults.length,
    trapFieldsTotal: trapFieldResults.length,
    trapFieldsCorrectlyUnresolved,
  };
}

function buildEvalContext(llmProvider: ReturnType<typeof createLlmProvider>): AppContext {
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
async function seedFixtures(context: AppContext, cases: EvalCase[]): Promise<void> {
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

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function printScorecard(providerName: string, model: string, scorecard: ProviderScorecard): void {
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
    "unresolved-recall (traps)": {
      value: formatPercent(scorecard.unresolvedRecall),
      detail: `${scorecard.trapFieldsCorrectlyUnresolved}/${scorecard.trapFieldsTotal} trap fields correctly refused`,
    },
  });
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

  const guessedTraps = caseResults.filter(
    (caseResult) =>
      caseResult.trapField !== undefined &&
      caseResult.fieldScores.find((fieldScore) => fieldScore.field === caseResult.trapField)?.correct === false,
  );
  if (guessedTraps.length > 0) {
    console.log("\nTrap cases where the model guessed instead of declining:");
    for (const caseResult of guessedTraps) {
      const trapScore = caseResult.fieldScores.find((fieldScore) => fieldScore.field === caseResult.trapField);
      console.log(`  - ${caseResult.id}: ${caseResult.trapField} -> "${trapScore?.actual}" (expected unresolved)`);
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
        cases: caseResults,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nWrote ${resultsFileUrl.pathname}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
