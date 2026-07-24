import { z } from "zod";
import {
  ACTIVITY_ACTOR_ROLES,
  ACTIVITY_EVENT_TYPES,
  APPLICATION_STATUSES,
  DOC_REVIEW_STATUSES,
  DOC_TYPES,
  PAYMENT_STATUSES,
  WIZARD_STEPS,
} from "./statuses";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoDateTime = z.string().datetime();
const iso2CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2");

export const UserSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().optional(),
  createdAt: isoDateTime,
});
export type User = z.infer<typeof UserSchema>;

// Storage schema: fullName/passportNumber allow draft placeholders so
// half-finished drafts round-trip. Forms and the submit guard use
// CompleteTravellerSchema below instead.
export const TravellerSchema = z.object({
  fullName: z.string(),
  dateOfBirth: isoDate,
  nationality: iso2CountryCode,
  passportNumber: z.string(),
  passportIssueDate: isoDate,
  passportExpiryDate: isoDate,
  photoKey: z.string().optional(),
  passportKey: z.string().optional(),
});
export type Traveller = z.infer<typeof TravellerSchema>;

export const DRAFT_PLACEHOLDER_PASSPORT = "PENDING";
export const DRAFT_PLACEHOLDER_DATE = "1900-01-01";

/** What a traveller must look like to actually submit — used by the wizard form AND the API submit guard. */
export const CompleteTravellerSchema = TravellerSchema.extend({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter the full name exactly as in the passport"),
  passportNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{5,15}$/, "Enter a valid passport number")
    .refine(
      (passportNumber) => passportNumber !== DRAFT_PLACEHOLDER_PASSPORT,
      "Enter a valid passport number",
    ),
})
  .refine((traveller) => traveller.dateOfBirth !== DRAFT_PLACEHOLDER_DATE, {
    message: "Enter the traveller's date of birth",
    path: ["dateOfBirth"],
  })
  .refine(
    (traveller) => traveller.passportIssueDate !== DRAFT_PLACEHOLDER_DATE,
    { message: "Enter the passport issue date", path: ["passportIssueDate"] },
  )
  .refine(
    (traveller) => traveller.passportExpiryDate > traveller.passportIssueDate,
    { message: "Expiry date must be after the issue date", path: ["passportExpiryDate"] },
  );

export const ApplicationAmountsSchema = z.object({
  governmentFeeInr: z.number().int().nonnegative(),
  serviceFeeInr: z.number().int().nonnegative(),
  currency: z.literal("INR"),
});

export const ApplicationEssentialsSchema = z.object({
  intendedTravelDate: isoDate,
  purposeOfTravel: z.string().min(1),
  contactPhone: z.string().min(8),
  residentialAddress: z.string().min(1),
});
export type ApplicationEssentials = z.infer<typeof ApplicationEssentialsSchema>;

export const ApplicationSchema = z.object({
  applicationId: z.string().min(1),
  userId: z.string().min(1),
  countryCode: iso2CountryCode,
  productCode: z.string().min(1),
  travellers: z.array(TravellerSchema).min(1),
  status: z.enum(APPLICATION_STATUSES),
  stepReached: z.enum(WIZARD_STEPS),
  essentials: ApplicationEssentialsSchema.optional(),
  amounts: ApplicationAmountsSchema,
  paymentStatus: z.enum(PAYMENT_STATUSES),
  internalNotes: z.array(z.string()).default([]),
  visaResultKey: z.string().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Application = z.infer<typeof ApplicationSchema>;

export const ApplicationDocumentSchema = z
  .object({
    applicationId: z.string().min(1),
    docType: z.enum(DOC_TYPES),
    travellerIndex: z.number().int().nonnegative(),
    s3Key: z.string().min(1),
    reviewStatus: z.enum(DOC_REVIEW_STATUSES),
    rejectReason: z.string().min(1).optional(),
    uploadedAt: isoDateTime,
  })
  .refine(
    (document) => document.reviewStatus !== "REJECTED" || document.rejectReason !== undefined,
    { message: "rejectReason is required when reviewStatus is REJECTED" },
  );
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;

export const ActivityEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(ACTIVITY_EVENT_TYPES),
  userId: z.string().min(1),
  applicationId: z.string().optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  createdAt: isoDateTime,
  actorEmail: z.string().email().optional(),
  actorRole: z.enum(ACTIVITY_ACTOR_ROLES).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
