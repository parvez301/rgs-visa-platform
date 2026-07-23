import { z } from "zod";
import {
  ACTIVITY_EVENT_TYPES,
  APPLICATION_STATUSES,
  DOC_REVIEW_STATUSES,
  DOC_TYPES,
  PAYMENT_STATUSES,
  WIZARD_STEPS,
} from "./statuses.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoDateTime = z.string().datetime();
const iso2CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2");

export const UserSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().min(8),
  createdAt: isoDateTime,
});
export type User = z.infer<typeof UserSchema>;

export const TravellerSchema = z.object({
  fullName: z.string().min(1),
  dateOfBirth: isoDate,
  nationality: iso2CountryCode,
  passportNumber: z.string().min(5),
  passportIssueDate: isoDate,
  passportExpiryDate: isoDate,
  photoKey: z.string().optional(),
  passportKey: z.string().optional(),
});
export type Traveller = z.infer<typeof TravellerSchema>;

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
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
