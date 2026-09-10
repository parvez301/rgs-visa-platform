import { z, ZodError } from "zod";
import { crm } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { badRequest } from "../lib/errors";
import { describeFirstZodIssue } from "../lib/storedRecords";
import type { CreateCaseApplicantInput } from "../domain/crm/cases";
import { findPartnerByName } from "../domain/crm/partners";
import { findTravellerByPassport } from "../domain/crm/travellers";
import { zodObjectToJsonSchema } from "./tools/registry";

/**
 * Structured intake extraction (task-12-brief.md, overridden by
 * task-12-controller-notes.md §1): turns a pasted enquiry -- a WhatsApp
 * paste, an email forward, an MRZ block -- into resolved CRM fields.
 *
 * This is a read-and-propose path with NO exceptions (controller-notes §3):
 * `extractIntake` never creates a partner, never creates a traveller, and
 * never touches `context.table` at all. A name or a passport that does not
 * resolve against the real store is surfaced unresolved -- never guessed,
 * and never used to mint a new record. Turning an unresolved field into a
 * real partner or traveller is a write, and every write in this codebase is
 * staged through the approval gate (Task 7/8), not minted from a paste.
 */

/**
 * The model's job is EXTRACTION, not resolution. It is asked to copy the
 * traveller name, passport number, destination and referrer exactly as the
 * text states them -- never to normalize a misspelling, never to translate a
 * service line ("PASSPORT NEW") or a multi-country trip ("TANZANIA/KENYA")
 * into a single guessed destination, and never to invent a value the text
 * does not contain. Resolution against the country map and the real
 * partner/traveller stores happens afterwards, in this file's own code,
 * where it can be tested without a network call. This split is what makes
 * the eval (eval/intakeCases.json, eval/runIntakeEval.ts) measure something
 * real: a provider that "helpfully" fixes a typo or fills in a plausible
 * destination the text never named is a provider that will file a case
 * under the wrong country with nobody the wiser -- exactly the failure
 * spec §7 warns "a model that misreads a passport number is not cheaper"
 * about.
 */
const INTAKE_EXTRACTION_SYSTEM_PROMPT = [
  "You extract structured fields from a pasted customer enquiry for a visa-services CRM intake " +
    "desk. Extract ONLY what the text actually states. Copy names, passport numbers, destinations " +
    "and referrer names EXACTLY as written -- do not correct spelling, do not expand an " +
    "abbreviation, do not translate a service line or a multi-country trip into a single " +
    "destination, and do not resolve anything to a country code or a database record yourself; " +
    "that happens elsewhere.",
  "If a field is not stated anywhere in the text, return the empty string \"\" for it (or 0 for " +
    "applicantCount when no headcount can be determined) -- never a plausible-sounding guess. A " +
    "confident wrong answer is scored as a worse failure than an honest blank, because it is the " +
    "one a human is least likely to catch before it reaches a case record.",
  "applicantCount is the total number of travellers the text describes (count named companions " +
    "such as \"+ wife\" or \"and family\" even when only one person is named individually); use 1 " +
    "when exactly one traveller is named with no headcount stated, and 0 only when the text gives " +
    "no way to tell.",
  "missingDocuments lists only documents the text says are still needed or missing. A document the " +
    "text says is already attached or provided is NOT a missing document.",
].join("\n\n");

/** The model's raw reply shape. Every field is required -- see the system prompt for the sentinel
 * convention ("" / 0) a provider uses in place of an optional field, chosen so the same JSON Schema
 * (via zodObjectToJsonSchema) works identically against Anthropic's forced-tool mechanism and
 * Gemini's native responseSchema, neither of which this codebase asks to emit a null. */
const RawIntakeExtractionSchema = z.object({
  travellerFullName: z.string(),
  passportNumber: z.string(),
  destinationCountryRaw: z.string(),
  partnerNameRaw: z.string(),
  applicantCount: z.number().int().nonnegative(),
  missingDocuments: z.array(z.string()),
});
type RawIntakeExtraction = z.infer<typeof RawIntakeExtractionSchema>;

// Exported (not just module-private) so the call-shape test can assert the
// exact schema sent to the provider, not merely that *some* value was sent
// (task-12-review.md m1: `responseSchema: {}` -- which would make both
// adapters' structured-output mechanism useless -- survived a `toBeDefined()`
// assertion undetected).
export const INTAKE_EXTRACTION_RESPONSE_SCHEMA = zodObjectToJsonSchema(RawIntakeExtractionSchema);

/**
 * A schema-valid `CreateCaseInput` in shape, plus the three fields the
 * pipeline can surface instead of a resolved value (task-12-brief.md
 * Interfaces). `applicants` never carries an entry this function invented --
 * it is populated only from a real `findTravellerByPassport` match, so an
 * empty array is the honest answer for a first-time traveller, not a bug.
 *
 * `travellerFullName` / `passportNumber` are carried at the top level
 * (beyond `CreateCaseInput`'s own shape) as-extracted, regardless of whether
 * the passport resolved: `applicants` alone cannot say what the text called
 * an unresolved traveller (`CreateCaseApplicantInput.travellerId` is
 * required, so an unresolved traveller cannot appear there at all), and a
 * human reviewing the draft -- or the eval scoring it -- needs to see what
 * the text said even when no matching record exists yet.
 */
export interface IntakeDraft {
  /** As the text stated it. Absent when the text names nobody. */
  travellerFullName?: string;
  /** As the text stated it. Absent when the text gives no passport number. */
  passportNumber?: string;
  /** ISO-3166 alpha-2. Present only when the destination resolved against the country map. */
  destinationCountry?: string;
  /** The raw destination text. Present only when it did NOT resolve -- never both this and destinationCountry. */
  unresolvedCountry?: string;
  /** Present only when the referrer name resolved against an existing partner. */
  partnerId?: string;
  /** The raw referrer text. Present only when it did NOT resolve -- never both this and partnerId. */
  unresolvedPartnerName?: string;
  /** Total headcount the text described, independent of how many resolved to a known traveller. */
  applicantCount: number;
  /** Only travellers an existing passport actually matched. Never a minted record. */
  applicants: CreateCaseApplicantInput[];
  receivedDate: string;
  /** Absent, not defaulted (task-12-review.md m3): nothing this function extracts states a
   * case type, so guessing "VISA" would be the one field on this draft holding a value the
   * text never supported -- every other unstated field on IntakeDraft is absent for the same
   * reason. A human confirms case type when they act on the draft. */
  caseType?: crm.CaseType;
  /** Present only when the destination resolved to a spelling the country map also flags as
   * naming a specific product (task-12-review.md m4), e.g. "Sri Lanka ETA" -> E_VISA. This is
   * `crm.normalizeCountry`'s own `visaTypeHint`, carried through rather than discarded --
   * still just a hint for a human, since caseType itself is never asserted here. */
  visaType?: crm.VisaType;
  missingDocuments: string[];
}

function parseRawExtraction(responseText: string): RawIntakeExtraction {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    // Not a caller mistake -- the caller only supplied rawText -- but there is
    // no "the upstream model misbehaved" ApiError in lib/errors, and a bare
    // parse failure here is exactly the kind of error router.ts would turn
    // into an opaque 500 if it escaped unwrapped.
    throw badRequest(
      "The model's structured reply was not valid JSON; intake extraction could not complete",
    );
  }
  try {
    return RawIntakeExtractionSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(
        `The model's structured reply did not match the expected shape: ${describeFirstZodIssue(error)}`,
      );
    }
    throw error;
  }
}

/**
 * Turns a pasted enquiry into an `IntakeDraft`. Never writes: no
 * `context.table.put`, no `createPartner`, no `upsertTraveller` -- only the
 * two read-only lookups named in the brief's Consumes list
 * (`findTravellerByPassport`, `findPartnerByName`) plus the deterministic,
 * store-free `crm.normalizeCountry`.
 *
 * `actorEmail` is accepted for interface parity with every other agent entry
 * point (Task 10's `runAgentTurn`, every write tool's `execute`) and because
 * a future audit trail on the intake screen is the obvious next caller of
 * it; today's read-and-propose extraction has nothing to attribute, since it
 * makes no mutation.
 */
export async function extractIntake(
  context: AppContext,
  tenantId: string,
  rawText: string,
  _actorEmail: string,
): Promise<IntakeDraft> {
  const llm = context.llm;
  if (llm === undefined) {
    // Mirrors runAgentTurn's own guard (loop.ts): a context with no provider
    // wired in is a caller bug, not a reason to dereference `undefined`.
    throw badRequest("This request has no LLM provider configured; intake extraction cannot run");
  }

  // controller-notes §1: responseSchema and a non-empty tools array are
  // mutually exclusive on both adapters. `runAgentTurn` always passes tools,
  // so this calls complete() directly instead, with tools: [].
  const completion = await llm.complete({
    system: INTAKE_EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
    tools: [],
    responseSchema: INTAKE_EXTRACTION_RESPONSE_SCHEMA,
  });

  const rawExtraction = parseRawExtraction(completion.text);

  const applicants: CreateCaseApplicantInput[] = [];
  if (rawExtraction.passportNumber !== "") {
    // The ONLY traveller-resolution path this function uses -- no
    // name-based fallback. findTravellerByName exists for the migration's
    // fuzzy 74%-no-passport case, but auto-attaching a case to a traveller
    // matched on name alone risks silently picking the WRONG person when two
    // travellers share a name; the brief's Consumes list names
    // findTravellerByPassport only, and a passport number is the one
    // identifier spec §5 treats as authoritative.
    const matchedTraveller = await findTravellerByPassport(
      context,
      tenantId,
      rawExtraction.passportNumber,
    );
    if (matchedTraveller !== undefined) {
      applicants.push({
        applicantRef: "A1",
        travellerId: matchedTraveller.travellerId,
        passportNumber: rawExtraction.passportNumber,
      });
    }
  }

  let partnerId: string | undefined;
  let unresolvedPartnerName: string | undefined;
  if (rawExtraction.partnerNameRaw !== "") {
    // findPartnerByName never creates -- a miss here means exactly one
    // thing: this name has no partner on file. Never becomes a new partner
    // (controller-notes §3 / brief step 2): that is a write, and writes are
    // staged, never minted from a paste.
    const matchedPartner = await findPartnerByName(context, tenantId, rawExtraction.partnerNameRaw);
    if (matchedPartner !== undefined) {
      partnerId = matchedPartner.partnerId;
    } else {
      unresolvedPartnerName = rawExtraction.partnerNameRaw;
    }
  }

  let destinationCountry: string | undefined;
  let unresolvedCountry: string | undefined;
  let visaType: crm.VisaType | undefined;
  if (rawExtraction.destinationCountryRaw !== "") {
    // The same deterministic country map the migration importer uses
    // (packages/shared/src/crm/normalize/country.ts) -- not the model's own
    // judgement. A model that faithfully copies a service line verbatim (as
    // instructed) lands here and comes out unresolved, because that string
    // is not a key in the map; a model that "helpfully" substitutes a real
    // country name instead is the failure this whole eval exists to catch,
    // and it would show up as a WRONG resolved country, not as a refusal. A
    // model that faithfully copies an unambiguous misspelling of a real
    // country name (e.g. "Myannmar") is expected to resolve here too --
    // task-12-review.md A2: that is the desk reading a typo the way a human
    // would, not a hallucination, and the map now carries it.
    const normalized = crm.normalizeCountry(rawExtraction.destinationCountryRaw);
    if (normalized.countryCode !== null) {
      destinationCountry = normalized.countryCode;
      if (normalized.visaTypeHint !== null) {
        visaType = normalized.visaTypeHint;
      }
    } else {
      unresolvedCountry = rawExtraction.destinationCountryRaw;
    }
  }

  return {
    ...(rawExtraction.travellerFullName !== ""
      ? { travellerFullName: rawExtraction.travellerFullName }
      : {}),
    ...(rawExtraction.passportNumber !== "" ? { passportNumber: rawExtraction.passportNumber } : {}),
    ...(destinationCountry !== undefined ? { destinationCountry } : {}),
    ...(unresolvedCountry !== undefined ? { unresolvedCountry } : {}),
    ...(partnerId !== undefined ? { partnerId } : {}),
    ...(unresolvedPartnerName !== undefined ? { unresolvedPartnerName } : {}),
    applicantCount: rawExtraction.applicantCount,
    applicants,
    // Filed as received today -- the desk is processing this paste now, and
    // nothing in a pasted enquiry states a different received date.
    receivedDate: context.now().toISOString().slice(0, 10),
    // caseType is intentionally absent -- see IntakeDraft's own doc comment.
    ...(visaType !== undefined ? { visaType } : {}),
    missingDocuments: rawExtraction.missingDocuments,
  };
}
