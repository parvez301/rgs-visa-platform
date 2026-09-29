import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  CUSTODY_STATUSES,
  ENTRY_TYPES,
  PROCESSING_SPEEDS,
  VISA_TYPES,
} from "./statuses";

/** The largest id batch one export-rows call accepts -- keeps a call well inside the 15 s Lambda timeout. */
export const MAX_EXPORT_CASE_IDS = 500;

/**
 * One spreadsheet row: one applicant, with their case's columns repeated.
 * Enum values stay raw on the wire; the admin maps them to labels.
 */
export const CaseExportRowSchema = z.object({
  caseId: z.string(),
  caseRef: z.string(),
  groupName: z.string().optional(),
  partnerName: z.string(),
  destinationCountry: z.string(),
  caseType: z.enum(CASE_TYPES),
  visaType: z.enum(VISA_TYPES).optional(),
  entryType: z.enum(ENTRY_TYPES).optional(),
  processing: z.enum(PROCESSING_SPEEDS).optional(),
  caseStatus: z.enum(CASE_STATUSES),
  billingStatus: z.enum(BILLING_STATUSES),
  receivedDate: z.string(),
  submissionDate: z.string().optional(),
  appointmentDate: z.string().optional(),
  expectedCollectionDate: z.string().optional(),
  totalInr: z.number(),
  clientEmail: z.string().optional(),
  remarks: z.string().optional(),
  applicantRefNo: z.string(),
  applicantName: z.string(),
  passportNumber: z.string().optional(),
  custody: z.enum(CUSTODY_STATUSES),
  outcome: z.enum(APPLICANT_OUTCOMES),
  trackingNumber: z.string().optional(),
});
export type CaseExportRow = z.infer<typeof CaseExportRowSchema>;
