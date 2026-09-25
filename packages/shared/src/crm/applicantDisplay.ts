import { z } from "zod";
import type { CaseApplicant } from "./schemas";

/**
 * What `GET /cases/{caseId}` attaches per traveller so the admin can show a
 * name beside each applicant (spec 2026-09-25 D7). Keyed by `travellerId`.
 */
export const CaseTravellerSummarySchema = z.object({
  fullName: z.string().min(1),
  passportNumber: z.string().optional(),
});
export type CaseTravellerSummary = z.infer<typeof CaseTravellerSummarySchema>;
export type CaseTravellerMap = Record<string, CaseTravellerSummary>;

export const UNNAMED_APPLICANT = "Unnamed applicant";

/**
 * The one display rule for an applicant's reference (spec 2026-09-25 §3.2):
 * their own `refNo` when set; the case REF when the case has exactly one
 * applicant (every imported case); otherwise the internal `applicantRef`.
 */
export function displayApplicantRef(
  caseRef: string,
  applicantCount: number,
  applicant: Pick<CaseApplicant, "applicantRef" | "refNo">,
): string {
  if (applicant.refNo !== undefined) return applicant.refNo;
  if (applicantCount === 1) return caseRef;
  return applicant.applicantRef;
}

export function displayApplicantName(
  travellers: CaseTravellerMap | undefined,
  applicant: Pick<CaseApplicant, "travellerId">,
): string {
  return travellers?.[applicant.travellerId]?.fullName ?? UNNAMED_APPLICANT;
}
