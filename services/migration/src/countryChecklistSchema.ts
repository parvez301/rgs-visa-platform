import { z } from "zod";

/**
 * Shape of a leftover CRM country checklist row (`COUNTRY#<iso2>` partition) in
 * Dynamo. Schema only -- nothing live reads or writes these rows any more; the
 * Postgres backfill reads them once to fold their labels into
 * `CountryProduct.requiredDocuments`.
 */
export const CountryChecklistSchema = z.object({
  countryCode: z.string().length(2),
  requiredDocuments: z.array(z.string().min(1)),
  notes: z.string().optional(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type CountryChecklist = z.infer<typeof CountryChecklistSchema>;
