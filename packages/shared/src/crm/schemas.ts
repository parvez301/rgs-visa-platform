import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  COURIER_MODES,
  CUSTODY_STATUSES,
  ENTRY_TYPES,
  LINE_ITEM_KINDS,
  PARTNER_TYPES,
  PROCESSING_SPEEDS,
  VISA_TYPES,
} from "./statuses";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoDateTime = z.string().datetime();
const iso2CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2");
const tenantId = z.string().min(1);

export const WATCHDOG_RULE_IDS = [
  "custody_held",
  "case_quiet",
  "appointment_docs",
  "courier_unconfirmed",
  "duplicate_passport",
  "billing_overdue",
] as const;
export type WatchdogRuleId = (typeof WATCHDOG_RULE_IDS)[number];

/** Tenant-wide defaults, in days. Spec §7. */
export const WatchdogConfigSchema = z.object({
  custody_held: z.number().int().positive().default(7),
  case_quiet: z.number().int().positive().default(5),
  courier_unconfirmed: z.number().int().positive().default(4),
  billing_overdue: z.number().int().positive().default(30),
});
export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>;

export const PartnerSchema = z.object({
  tenantId,
  partnerId: z.string().min(1),
  canonicalName: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  partnerType: z.enum(PARTNER_TYPES),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactWhatsapp: z.string().optional(),
  notes: z.string().optional(),
  createdAt: isoDateTime,
  // The admin who created the partner. Not .email(): the same reason
  // CrmCaseSchema gives — an admin token may carry no email claim, and the API
  // omits the field rather than storing an empty string.
  createdByEmail: z.string().min(1).optional(),
});
export type Partner = z.infer<typeof PartnerSchema>;

export const CrmTravellerSchema = z.object({
  tenantId,
  travellerId: z.string().min(1),
  fullName: z.string().trim().min(1),
  normalizedName: z.string().min(1),
  dateOfBirth: isoDate.optional(),
  phone: z.string().optional(),
  passportNumber: z.string().optional(),
  createdAt: isoDateTime,
});
export type CrmTraveller = z.infer<typeof CrmTravellerSchema>;

export const LineItemSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  // The UNIT price, not a line total -- CrmCase.totalInr is the sum, across
  // every line item, of amountInr × quantity. A stored per-line total sitting
  // next to a quantity is redundant and the two can disagree; a unit price
  // cannot disagree with itself.
  amountInr: z.number().int().nonnegative(),
  quantity: z.number().int().positive().default(1),
  kind: z.enum(LINE_ITEM_KINDS),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const CaseApplicantSchema = z.object({
  applicantRef: z.string().min(1),
  travellerId: z.string().min(1),
  passportNumber: z.string().optional(),
  custody: z.enum(CUSTODY_STATUSES).default("NOT_HELD"),
  custodySince: isoDateTime.optional(),
  outcome: z.enum(APPLICANT_OUTCOMES).default("PENDING"),
  courierMode: z.enum(COURIER_MODES).optional(),
  trackingNumber: z.string().optional(),
  visaResultKey: z.string().optional(),
});
export type CaseApplicant = z.infer<typeof CaseApplicantSchema>;

export const CrmCaseSchema = z
  .object({
    tenantId,
    caseId: z.string().min(1),
    caseRef: z.string().min(1),
    caseType: z.enum(CASE_TYPES),
    partnerId: z.string().min(1),
    destinationCountry: iso2CountryCode,
    visaType: z.enum(VISA_TYPES).optional(),
    entryType: z.enum(ENTRY_TYPES).optional(),
    processing: z.enum(PROCESSING_SPEEDS).optional(),
    validity: z.string().optional(),
    caseStatus: z.enum(CASE_STATUSES),
    billingStatus: z.enum(BILLING_STATUSES),
    receivedDate: isoDate,
    submissionDate: isoDate.optional(),
    appointmentDate: isoDate.optional(),
    expectedCollectionDate: isoDate.optional(),
    courierDate: isoDate.optional(),
    lineItems: z.array(LineItemSchema).default([]),
    totalInr: z.number().int().nonnegative().default(0),
    applicants: z.array(CaseApplicantSchema).min(1, "a case needs at least one applicant"),
    watchdogOverrides: z.record(z.enum(WATCHDOG_RULE_IDS), z.number().int().positive()).default({}),
    mutedRules: z.array(z.enum(WATCHDOG_RULE_IDS)).default([]),
    snoozedUntil: isoDateTime.optional(),
    sourceSheet: z.string().optional(),
    sourceRow: z.number().int().positive().optional(),
    legacyRaw: z.record(z.string(), z.string()).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    // Derived from the admin token's `email` claim, which is not guaranteed —
    // the API defaults it away when absent rather than storing an empty string.
    // .email() here turned an admin whose token carries no email claim into a
    // 400 on case creation while every other admin route kept working.
    createdByEmail: z.string().min(1).optional(),
  })
  .refine(
    (crmCase) => crmCase.caseType !== "VISA" || crmCase.visaType !== undefined,
    { message: "a VISA case needs a visaType", path: ["visaType"] },
  )
  .refine(
    (crmCase) => crmCase.caseType === "VISA" || crmCase.visaType === undefined,
    { message: "only a VISA case may carry a visaType", path: ["visaType"] },
  );
export type CrmCase = z.infer<typeof CrmCaseSchema>;

export const CountryProfileSchema = z.object({
  tenantId,
  countryCode: iso2CountryCode,
  checklistItems: z.array(z.string()).default([]),
  driveFolderUrl: z.string().url().optional(),
  processingDays: z.number().int().positive().optional(),
  notes: z.string().optional(),
  updatedAt: isoDateTime,
});
export type CountryProfile = z.infer<typeof CountryProfileSchema>;

export const CrmMemorySchema = z
  .object({
    tenantId,
    scope: z.string().min(1),
    memoryKey: z.string().min(1),
    text: z.string().trim().min(1).max(2000),
    sourceCaseId: z.string().optional(),
    createdBy: z.enum(["agent", "human"]),
    createdAt: isoDateTime,
    // Derived from the admin token's `email` claim, which is not guaranteed —
    // the API defaults it away when absent rather than storing an empty
    // string. Mirrors CrmCaseSchema.createdByEmail above exactly, including
    // its reason. NOT what `createdBy` records: `createdBy` is "agent" |
    // "human" (what kind of author), this is who -- keeping the two apart is
    // what lets the refinement below key off `createdBy` alone.
    createdByEmail: z.string().min(1).optional(),
  })
  .refine(
    (memory) => memory.createdBy !== "agent" || memory.sourceCaseId !== undefined,
    {
      message: "an agent-created memory must cite the case it learned from",
      path: ["sourceCaseId"],
    },
  );
export type CrmMemory = z.infer<typeof CrmMemorySchema>;

export const CrmUserPrefsSchema = z.object({
  tenantId,
  email: z.string().email(),
  trustLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  autoApplyOptIn: z.boolean().default(false),
  defaultFilters: z.record(z.string(), z.string()).default({}),
  // Added for the agent trust ladder (task-10-controller-notes.md §9): how
  // many staged proposals this user has approved with no edit, one signal a
  // future screen can use to PROPOSE advancing trustLevel. Counting alone
  // never moves trustLevel or autoApplyOptIn -- advancement is opt-in, never
  // silent (task-10-controller-notes.md §6).
  confirmedWithoutEditCount: z.number().int().nonnegative().default(0),
});
export type CrmUserPrefs = z.infer<typeof CrmUserPrefsSchema>;
