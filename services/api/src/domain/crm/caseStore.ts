import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { readCasePostgres, writeCasePostgres } from "./caseStorePostgres";
import { requireSql } from "./postgresClient";

/** Case persistence: thin wrappers over the Postgres case adapter. */

export async function writeCase(context: AppContext, crmCase: crm.CrmCase): Promise<void> {
  await writeCasePostgres(requireSql(context), crmCase);
}

export async function readCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase | undefined> {
  return readCasePostgres(requireSql(context), tenantId, caseId);
}

export async function readCaseOrThrow(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  const loadedCase = await readCase(context, tenantId, caseId);
  if (!loadedCase) throw notFound("Case");
  return loadedCase;
}
