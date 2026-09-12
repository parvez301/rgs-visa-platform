import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  CUSTODY_STATUSES,
  VISA_TYPES,
  type ApplicantOutcome,
  type CustodyStatus,
} from "./statuses";
// CaseApplicant lives in schemas.ts (it is z.infer<typeof CaseApplicantSchema>),
// not in statuses.ts alongside the state-tuple types above -- the two files
// are separate imports for exactly that reason.
import type { CaseApplicant } from "./schemas";

/**
 * How many applicants on a case are in each state, carried on the case's own
 * META item so the Ledger can show a roll-up without reading a single
 * applicant record.
 *
 * Only states that actually occur appear. A state nobody is in is absent, not
 * zero: nine zero keys on every one of 7,156 stored cases is about a megabyte
 * added to every Ledger page, and `count` minus the sum already says it.
 */
export interface ApplicantSummary {
  count: number;
  custody: Partial<Record<CustodyStatus, number>>;
  outcome: Partial<Record<ApplicantOutcome, number>>;
}

/**
 * A counts-by-state validator built from the state tuple itself, so adding a
 * custody state to `statuses.ts` cannot leave a second list here out of date.
 *
 * `.strict()`, not the default strip: an unknown key means a stored summary
 * names a state this build does not have, and stripping it would let the row
 * through carrying a count that silently vanished. Refused instead, which
 * lands the case in `unreadableCaseIds` where an operator can see it.
 *
 * The cast is the one place this file needs one: `z.object` over a computed
 * shape infers `ZodObject<Record<string, ...>>`, and the state union is what
 * every consumer actually wants to switch on.
 */
function stateCountsSchema<StateType extends string>(
  allowedStates: readonly StateType[],
): z.ZodType<Partial<Record<StateType, number>>> {
  const countsShape = Object.fromEntries(
    allowedStates.map((stateName) => [stateName, z.number().int().nonnegative().optional()]),
  );
  return z.object(countsShape).strict() as unknown as z.ZodType<Partial<Record<StateType, number>>>;
}

export const ApplicantSummarySchema: z.ZodType<ApplicantSummary> = z.object({
  count: z.number().int().nonnegative(),
  custody: stateCountsSchema(CUSTODY_STATUSES),
  outcome: stateCountsSchema(APPLICANT_OUTCOMES),
});

/**
 * The one computation of a case's roll-up. Called from `writeCase` and from
 * nowhere else in production code — see the comment there for why that is the
 * property worth protecting.
 */
export function summariseApplicants(
  applicants: readonly Pick<CaseApplicant, "custody" | "outcome">[],
): ApplicantSummary {
  const custodyCounts: Partial<Record<CustodyStatus, number>> = {};
  const outcomeCounts: Partial<Record<ApplicantOutcome, number>> = {};
  for (const applicant of applicants) {
    custodyCounts[applicant.custody] = (custodyCounts[applicant.custody] ?? 0) + 1;
    outcomeCounts[applicant.outcome] = (outcomeCounts[applicant.outcome] ?? 0) + 1;
  }
  return { count: applicants.length, custody: custodyCounts, outcome: outcomeCounts };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * One row of the Ledger: exactly the columns spec §4 lists, and nothing else.
 *
 * This is what the projection route reads off a case META item — never
 * `legacyRaw`, never `lineItems`, never the applicant records. The same type
 * is parsed on the server (to name a row it could not read) and consumed by
 * the React client, so a column added here is a column both sides agree on.
 *
 * `applicantSummary` is optional and that is a statement about real data, not
 * a convenience: 7,156 cases were imported before `writeCase` computed one.
 * The Ledger renders those as "not summarised" rather than as a fabricated
 * zero, and the Plan 5 backfill (`services/migration/src/backfillApplicantSummary.ts`)
 * is what removes them.
 */
export const LedgerRowSchema = z.object({
  caseId: z.string().min(1),
  caseRef: z.string().min(1),
  partnerId: z.string().min(1),
  destinationCountry: z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2"),
  caseType: z.enum(CASE_TYPES),
  visaType: z.enum(VISA_TYPES).optional(),
  caseStatus: z.enum(CASE_STATUSES),
  billingStatus: z.enum(BILLING_STATUSES),
  receivedDate: isoDate,
  appointmentDate: isoDate.optional(),
  totalInr: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  applicantSummary: ApplicantSummarySchema.optional(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;
