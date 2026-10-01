import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { CorruptRecordError } from "../../lib/errors";
import { readCase } from "./caseStore";
import { resolveCaseTravellers } from "./caseTravellers";
import { listPartners } from "./partners";

/** Parallel reads per batch: fast enough for 500 cases in a few seconds, gentle on on-demand capacity. */
const EXPORT_READ_CONCURRENCY = 20;

/**
 * Under CRM_STORE=postgres every read shares `createPgSqlClient`'s one-connection
 * pool, so a 20-way fan-out buys no parallelism: it only queues 20 waiters on
 * the pool, and a waiter that sits past `connectionTimeoutMillis` fails. Read
 * serially there; the per-case cost is two queries plus one traveller batch.
 */
export const POSTGRES_EXPORT_READ_CONCURRENCY = 1;

export function exportReadConcurrency(context: AppContext): number {
  return context.crmStore === "postgres" ? POSTGRES_EXPORT_READ_CONCURRENCY : EXPORT_READ_CONCURRENCY;
}

async function mapWithConcurrency<InputType, OutputType>(
  inputs: readonly InputType[],
  concurrencyLimit: number,
  mapInput: (input: InputType) => Promise<OutputType>,
): Promise<OutputType[]> {
  const outputs: OutputType[] = new Array(inputs.length);
  let nextInputIndex = 0;
  async function drainQueue(): Promise<void> {
    while (nextInputIndex < inputs.length) {
      const inputIndex = nextInputIndex;
      nextInputIndex += 1;
      outputs[inputIndex] = await mapInput(inputs[inputIndex]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencyLimit, inputs.length) }, drainQueue));
  return outputs;
}

/**
 * The rows behind the Ledger's "Export to Excel". The caller sends the case
 * ids it is SHOWING (filters and search run in the browser, so the server
 * cannot rebuild that set itself) and gets them back in the same order. An
 * id that is gone or unreadable is named in missingCaseIds, never dropped
 * silently -- a spreadsheet one row short with no explanation is worse than
 * a note saying which rows are missing.
 */
export async function buildCaseExportRows(
  context: AppContext,
  tenantId: string,
  caseIds: readonly string[],
): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }> {
  const partnerListing = await listPartners(context, tenantId);
  const partnerNamesById = new Map(
    partnerListing.partners.map((partner) => [partner.partnerId, partner.canonicalName]),
  );

  const loadedCases = await mapWithConcurrency(caseIds, exportReadConcurrency(context), async (caseId) => {
    try {
      const storedCase = await readCase(context, tenantId, caseId);
      if (storedCase === undefined) return { caseId, storedCase: undefined, travellers: {} };
      const travellers = await resolveCaseTravellers(context, tenantId, storedCase.applicants);
      return { caseId, storedCase, travellers };
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      return { caseId, storedCase: undefined, travellers: {} };
    }
  });

  const rows: crm.CaseExportRow[] = [];
  const missingCaseIds: string[] = [];
  for (const { caseId, storedCase, travellers } of loadedCases) {
    if (storedCase === undefined) {
      missingCaseIds.push(caseId);
      continue;
    }
    for (const applicant of storedCase.applicants) {
      rows.push({
        caseId: storedCase.caseId,
        caseRef: storedCase.caseRef,
        ...(storedCase.groupName !== undefined ? { groupName: storedCase.groupName } : {}),
        partnerName: partnerNamesById.get(storedCase.partnerId) ?? storedCase.partnerId,
        destinationCountry: storedCase.destinationCountry,
        caseType: storedCase.caseType,
        ...(storedCase.visaType !== undefined ? { visaType: storedCase.visaType } : {}),
        ...(storedCase.entryType !== undefined ? { entryType: storedCase.entryType } : {}),
        ...(storedCase.processing !== undefined ? { processing: storedCase.processing } : {}),
        caseStatus: storedCase.caseStatus,
        billingStatus: storedCase.billingStatus,
        receivedDate: storedCase.receivedDate,
        ...(storedCase.submissionDate !== undefined ? { submissionDate: storedCase.submissionDate } : {}),
        ...(storedCase.appointmentDate !== undefined ? { appointmentDate: storedCase.appointmentDate } : {}),
        ...(storedCase.expectedCollectionDate !== undefined
          ? { expectedCollectionDate: storedCase.expectedCollectionDate }
          : {}),
        totalInr: storedCase.totalInr,
        ...(storedCase.clientEmail !== undefined ? { clientEmail: storedCase.clientEmail } : {}),
        ...(storedCase.remarks !== undefined ? { remarks: storedCase.remarks } : {}),
        applicantRefNo: crm.displayApplicantRef(storedCase.caseRef, storedCase.applicants.length, applicant),
        applicantName: crm.displayApplicantName(travellers, applicant),
        ...((applicant.passportNumber ?? travellers[applicant.travellerId]?.passportNumber) !== undefined
          ? { passportNumber: applicant.passportNumber ?? travellers[applicant.travellerId]?.passportNumber }
          : {}),
        custody: applicant.custody,
        outcome: applicant.outcome,
        ...(applicant.trackingNumber !== undefined ? { trackingNumber: applicant.trackingNumber } : {}),
      });
    }
  }
  return { rows, missingCaseIds };
}
