import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, statusEmailTemplatePartitionKey } from "./keys";
import { crmPostgresOf } from "./postgresClient";
import {
  getStatusEmailTemplatePostgres,
  insertStatusEmailTemplateIfAbsentPostgres,
  upsertStatusEmailTemplatePostgres,
} from "./statusEmailTemplatesPostgres";

/**
 * What an unpersisted default reports as its `updatedAt`. StatusEmailTemplate
 * requires a datetime, and inventing "now" for a row nobody wrote would read
 * as an edit. Epoch plus `updatedBy: ""` is the marker for "never saved".
 */
export const UNSAVED_TEMPLATE_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export async function getStatusEmailTemplate(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
): Promise<crm.StatusEmailTemplate | undefined> {
  const sql = crmPostgresOf(context);
  if (sql !== undefined) return getStatusEmailTemplatePostgres(sql, tenantId, caseStatus);
  const storedItem = await context.table.get(statusEmailTemplatePartitionKey(tenantId, caseStatus), META_SORT_KEY);
  if (storedItem === undefined) return undefined;
  return parseStoredRecord(
    crm.StatusEmailTemplateSchema,
    "StatusEmailTemplate",
    caseStatus,
    stripStorageKeys(storedItem),
  );
}

/** One entry per case status: the stored row if there is one, else the in-memory default. Defaults are not persisted. */
export async function listStatusEmailTemplates(
  context: AppContext,
  tenantId: string,
): Promise<crm.StatusEmailTemplate[]> {
  return Promise.all(
    crm.CASE_STATUSES.map(async (caseStatus): Promise<crm.StatusEmailTemplate> => {
      const stored = await getStatusEmailTemplate(context, tenantId, caseStatus);
      if (stored !== undefined) return stored;
      return {
        tenantId,
        caseStatus,
        ...crm.defaultStatusEmailTemplate(caseStatus),
        updatedAt: UNSAVED_TEMPLATE_UPDATED_AT,
        updatedBy: "",
      };
    }),
  );
}

async function writeTemplate(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  fields: crm.UpsertStatusEmailTemplateBody,
  actorEmail: string,
  onlyIfAbsent: boolean,
): Promise<{ template: crm.StatusEmailTemplate; written: boolean }> {
  let template: crm.StatusEmailTemplate;
  try {
    template = crm.StatusEmailTemplateSchema.parse({
      tenantId,
      caseStatus,
      ...fields,
      updatedAt: context.now().toISOString(),
      updatedBy: actorEmail,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid status email template",
      );
    }
    throw error;
  }
  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    if (onlyIfAbsent) return { template, written: await insertStatusEmailTemplateIfAbsentPostgres(sql, template) };
    await upsertStatusEmailTemplatePostgres(sql, template);
    return { template, written: true };
  }
  const item = { PK: statusEmailTemplatePartitionKey(tenantId, caseStatus), SK: META_SORT_KEY, ...template };
  if (onlyIfAbsent) {
    return { template, written: await context.table.putIfAbsent(item) };
  }
  await context.table.put(item);
  return { template, written: true };
}

export async function upsertStatusEmailTemplate(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  body: crm.UpsertStatusEmailTemplateBody,
  actorEmail: string,
): Promise<crm.StatusEmailTemplate> {
  const { template } = await writeTemplate(context, tenantId, caseStatus, body, actorEmail, false);
  return template;
}

/** Overwrites the row with the built-in default, stamped with who reset it. */
export async function resetStatusEmailTemplate(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<crm.StatusEmailTemplate> {
  return upsertStatusEmailTemplate(
    context,
    tenantId,
    caseStatus,
    crm.defaultStatusEmailTemplate(caseStatus),
    actorEmail,
  );
}

/** Insert-if-absent for every status, so desk edits survive a re-run. Returns how many rows were inserted. */
export async function seedStatusEmailTemplatesIfAbsent(
  context: AppContext,
  tenantId: string,
  actorEmail: string,
): Promise<number> {
  let insertedCount = 0;
  for (const caseStatus of crm.CASE_STATUSES) {
    const { written } = await writeTemplate(
      context,
      tenantId,
      caseStatus,
      crm.defaultStatusEmailTemplate(caseStatus),
      actorEmail,
      true,
    );
    if (written) insertedCount += 1;
  }
  return insertedCount;
}
