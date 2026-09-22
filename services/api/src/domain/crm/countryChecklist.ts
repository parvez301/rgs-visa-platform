import { z } from "zod";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, notFound } from "../../lib/errors";
import { parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, countryChecklistPartitionKey } from "./keys";

/**
 * The documents a destination country requires on every case bound for it.
 * `updatedBy` exists because "who changed the Japan list?" is exactly the
 * question a desk asks about a checklist -- this is not a CRM case, so it
 * records no `CrmEventType` (that union is closed over six case-scoped
 * strings built from a case partition), and stamping the writer directly on
 * the record is the attribution this record gets instead.
 */
export const CountryChecklistSchema = z.object({
  countryCode: z.string().length(2),
  requiredDocuments: z.array(z.string().min(1)),
  notes: z.string().optional(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type CountryChecklist = z.infer<typeof CountryChecklistSchema>;

export interface PutCountryChecklistInput {
  countryCode: string;
  requiredDocuments: string[];
  notes?: string;
}

export async function putCountryChecklist(
  context: AppContext,
  tenantId: string,
  input: PutCountryChecklistInput,
  actorEmail: string,
): Promise<CountryChecklist> {
  const nowIso = context.now().toISOString();
  let checklist: CountryChecklist;
  try {
    checklist = CountryChecklistSchema.parse({
      countryCode: input.countryCode,
      requiredDocuments: input.requiredDocuments,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: nowIso,
      updatedBy: actorEmail,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid country checklist",
      );
    }
    throw error;
  }
  await context.table.put({
    PK: countryChecklistPartitionKey(tenantId, checklist.countryCode),
    SK: META_SORT_KEY,
    ...checklist,
  });
  return checklist;
}

export async function getCountryChecklist(
  context: AppContext,
  tenantId: string,
  countryCode: string,
): Promise<CountryChecklist> {
  const checklist = await findCountryChecklist(context, tenantId, countryCode);
  if (checklist === undefined) {
    throw notFound(`No document checklist is on file for ${countryCode}`);
  }
  return checklist;
}

/** Soft read used when stamping a case -- missing country list is not an error. */
export async function findCountryChecklist(
  context: AppContext,
  tenantId: string,
  countryCode: string,
): Promise<CountryChecklist | undefined> {
  const storedItem = await context.table.get(
    countryChecklistPartitionKey(tenantId, countryCode),
    META_SORT_KEY,
  );
  if (storedItem === undefined) return undefined;
  // Raw, a ZodError escapes router.ts's ApiError-only mapping as a 500 the
  // moment a checklist row is hand-repaired or half-written -- the same
  // failure readCase and parseStoredPartner both guard against.
  return parseStoredRecord(
    CountryChecklistSchema,
    "CountryChecklist",
    countryCode,
    stripStorageKeys(storedItem),
  );
}
