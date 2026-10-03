import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { readCasesPostgres } from "./caseStorePostgres";
import { requireSql } from "./postgresClient";
import { resolveCaseTravellers } from "./caseTravellers";
import { listPartners } from "./partners";

type LoadedExportCase = {
  caseId: string;
  storedCase: crm.CrmCase | undefined;
  travellers: crm.CaseTravellerMap;
};

/**
 * Every statement queues on `createPgSqlClient`'s one-connection pool, so
 * fan-out buys nothing and per-case reads cost ~3 round-trips each (1,500 for
 * 500 cases). Load the whole set instead: one `crm_cases` query, one
 * `crm_applicants` query and one `crm_travellers` query for the batch -- a
 * constant ~3 round-trips however many ids are exported.
 */
async function loadExportCases(
  context: AppContext,
  tenantId: string,
  caseIds: readonly string[],
): Promise<LoadedExportCase[]> {
  const { cases } = await readCasesPostgres(requireSql(context), tenantId, caseIds);
  const allApplicants = [...cases.values()].flatMap((storedCase) => storedCase.applicants);
  // One map for the whole export: the row builder looks travellers up by id.
  const travellers = await resolveCaseTravellers(context, tenantId, allApplicants);
  return caseIds.map((caseId) => ({ caseId, storedCase: cases.get(caseId), travellers }));
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

  const loadedCases = await loadExportCases(context, tenantId, caseIds);

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
