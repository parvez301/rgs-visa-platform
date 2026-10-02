import {
  ApplicationSchema,
  ApplicationEssentialsSchema,
  CompleteTravellerSchema,
  TravellerSchema,
  portalDocTypesFromProduct,
  type Application,
  type ApplicationDocument,
  type CountryProduct,
  type DocType,
  type WizardStep,
} from "@rgs/shared";
import { ZodError, z } from "zod";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import type { TableItem } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import {
  collectReadableRecords,
  parseStoredRecord,
  storedRecordId,
} from "../lib/storedRecords";
import { resolveCountryProduct } from "./config";
import { crmPostgresOf } from "./crm/postgresClient";
import {
  getApplicationPostgres,
  listApplicationsByUserPostgres,
  upsertApplicationPostgres,
} from "./applicationsPostgres";
import {
  getApplicationDocumentPostgres,
  listApplicationDocumentsPostgres,
  upsertApplicationDocumentPostgres,
} from "./applicationDocumentsPostgres";
import { ensureUserProfile } from "./users";

export function applicationToItem(application: Application): TableItem {
  return {
    PK: `USER#${application.userId}`,
    SK: `APP#${application.applicationId}`,
    GSI1PK: `STATUS#${application.status}`,
    GSI1SK: application.updatedAt,
    GSI3PK: `APP#${application.applicationId}`,
    GSI3SK: "A",
    ...application,
  };
}

/**
 * The single place a stored row becomes an Application.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses — so one half-written APP# item answered 500 from every read
 * that touched it, including the ops team's main work queue. Typed as
 * CorruptRecordError it answers 409 naming the row, exactly as the CRM
 * listings do, and a listing can then catch precisely this and skip.
 */
export function itemToApplication(item: TableItem): Application {
  // The whole item, storage keys included: ApplicationSchema is a plain
  // z.object, which drops unknown keys, so stripping them first would be work
  // with no effect.
  return parseStoredRecord(
    ApplicationSchema,
    "Application",
    storedRecordId(item, "applicationId"),
    item,
  );
}

/** Persists an application to whichever store this context uses (Postgres or Dynamo). */
export async function saveApplication(
  context: AppContext,
  application: Application,
): Promise<void> {
  const sql = crmPostgresOf(context);
  if (sql) {
    await upsertApplicationPostgres(sql, application);
    return;
  }
  await context.table.put(applicationToItem(application));
}

export async function createDraft(
  context: AppContext,
  userId: string,
  countryCode: string,
  email: string,
): Promise<Application> {
  await ensureUserProfile(context, userId, email);
  const countryProduct = await resolveCountryProduct(context, countryCode);
  if (!countryProduct.active || countryProduct.tier !== "FULFILLED") {
    throw badRequest(
      `${countryProduct.countryName} applications aren't available online yet — contact us and we'll assist directly`,
    );
  }
  const createdAt = context.now().toISOString();
  const application: Application = {
    applicationId: newId("app", context.now().getTime()),
    userId,
    countryCode: countryProduct.countryCode,
    productCode: countryProduct.productCode,
    travellers: [
      {
        fullName: "",
        dateOfBirth: "1900-01-01",
        nationality: "IN",
        passportNumber: "PENDING",
        passportIssueDate: "1900-01-01",
        passportExpiryDate: "1900-01-01",
      },
    ],
    status: "DRAFT",
    stepReached: "travellers",
    amounts: {
      governmentFeeInr: countryProduct.governmentFeeInr,
      serviceFeeInr: countryProduct.serviceFeeInr,
      currency: "INR",
    },
    paymentStatus: "UNPAID",
    internalNotes: [],
    createdAt,
    updatedAt: createdAt,
  };
  await saveApplication(context, application);
  await logActivity(
    context,
    "APPLICATION_STARTED",
    userId,
    application.applicationId,
    { countryCode: countryProduct.countryCode },
    { actorEmail: email, actorRole: "user" },
  );
  return application;
}

export const PatchDraftSchema = z.object({
  travellers: z.array(TravellerSchema).min(1).max(9).optional(),
  essentials: ApplicationEssentialsSchema.optional(),
  stepReached: z.enum(["travellers", "docs", "essentials", "review"]).optional(),
});
export type PatchDraftInput = z.infer<typeof PatchDraftSchema>;

export async function getOwnedApplication(
  context: AppContext,
  userId: string,
  applicationId: string,
): Promise<Application> {
  const sql = crmPostgresOf(context);
  if (sql) {
    const application = await getApplicationPostgres(sql, applicationId);
    // Another user's application answers exactly like a missing one.
    if (!application || application.userId !== userId) throw notFound("Application");
    return application;
  }
  const item = await context.table.get(`USER#${userId}`, `APP#${applicationId}`);
  if (!item) throw notFound("Application");
  return itemToApplication(item);
}

export async function patchDraft(
  context: AppContext,
  userId: string,
  applicationId: string,
  patch: PatchDraftInput,
  email: string,
): Promise<Application> {
  const application = await getOwnedApplication(context, userId, applicationId);
  if (application.status !== "DRAFT") {
    throw conflict("Only draft applications can be edited");
  }
  const previousStep = application.stepReached;
  const updatedApplication: Application = {
    ...application,
    ...(patch.travellers ? { travellers: patch.travellers } : {}),
    ...(patch.essentials ? { essentials: patch.essentials } : {}),
    ...(patch.stepReached ? { stepReached: patch.stepReached } : {}),
    updatedAt: context.now().toISOString(),
  };
  await saveApplication(context, updatedApplication);
  if (patch.stepReached && patch.stepReached !== previousStep) {
    await logActivity(
      context,
      "STEP_COMPLETED",
      userId,
      applicationId,
      {
        step: previousStep,
        nextStep: patch.stepReached,
      },
      { actorEmail: email, actorRole: "user" },
    );
  }
  return updatedApplication;
}

export interface OwnedApplicationListing {
  applications: Application[];
  /**
   * The applicant's own rows that could not be reassembled. Named rather than
   * merely absent: a customer whose application vanishes from their portal has
   * no way to tell that from one that was never created. This listing used to
   * answer 409 CORRUPT_RECORD for the whole page rather than for the one bad
   * row, so a single half-written draft cost the applicant every application
   * they had.
   */
  unreadableApplicationIds: string[];
}

export async function listMyApplications(
  context: AppContext,
  userId: string,
): Promise<OwnedApplicationListing> {
  const sql = crmPostgresOf(context);
  if (sql) return listApplicationsByUserPostgres(sql, userId);
  const items = await context.table.query(`USER#${userId}`, { skPrefix: "APP#" });
  const { records, unreadableRecordIds } = await collectReadableRecords(
    items,
    itemToApplication,
    { entityDescription: "application" },
  );
  return { applications: records, unreadableApplicationIds: unreadableRecordIds };
}

export async function listApplicationDocuments(
  context: AppContext,
  applicationId: string,
): Promise<ApplicationDocument[]> {
  const sql = crmPostgresOf(context);
  if (sql) return (await listApplicationDocumentsPostgres(sql, applicationId)).documents;
  const items = await context.table.query(`APP#${applicationId}`, { skPrefix: "DOC#" });
  return items.map((item) => {
    const { PK, SK, ...documentAttributes } = item;
    return documentAttributes as unknown as ApplicationDocument;
  });
}

/** Persists document metadata to whichever store this context uses. S3 bytes are untouched. */
export async function saveApplicationDocument(
  context: AppContext,
  document: ApplicationDocument,
): Promise<void> {
  const sql = crmPostgresOf(context);
  if (sql) {
    await upsertApplicationDocumentPostgres(sql, document);
    return;
  }
  await context.table.put({
    PK: `APP#${document.applicationId}`,
    SK: `DOC#${document.docType}#${document.travellerIndex}`,
    ...document,
  });
}

/** One document's stored metadata, or undefined when none was recorded. */
export async function getApplicationDocument(
  context: AppContext,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
): Promise<ApplicationDocument | undefined> {
  const sql = crmPostgresOf(context);
  if (sql) return getApplicationDocumentPostgres(sql, applicationId, docType, travellerIndex);
  const item = await context.table.get(`APP#${applicationId}`, `DOC#${docType}#${travellerIndex}`);
  if (!item) return undefined;
  const { PK, SK, ...documentAttributes } = item;
  return documentAttributes as unknown as ApplicationDocument;
}

/** Docs required for submission: every traveller needs each doc on the country checklist. */
export function missingDocuments(
  countryProduct: CountryProduct,
  application: Application,
  uploadedDocuments: ApplicationDocument[],
): string[] {
  const requiredDocTypes = portalDocTypesFromProduct(countryProduct);
  const missing: string[] = [];
  application.travellers.forEach((_traveller, travellerIndex) => {
    for (const requiredDocType of requiredDocTypes) {
      const uploaded = uploadedDocuments.some(
        (uploadedDocument) =>
          uploadedDocument.docType === requiredDocType &&
          uploadedDocument.travellerIndex === travellerIndex &&
          uploadedDocument.reviewStatus !== "REJECTED",
      );
      if (!uploaded) missing.push(`traveller ${travellerIndex + 1}: ${requiredDocType}`);
    }
  });
  return missing;
}

export async function submitApplication(
  context: AppContext,
  userId: string,
  applicationId: string,
  userEmail: string,
): Promise<Application> {
  const application = await getOwnedApplication(context, userId, applicationId);
  if (application.status !== "DRAFT") {
    throw conflict("Application has already been submitted");
  }
  if (!application.essentials) {
    throw badRequest("Travel details (essentials) must be completed before submitting");
  }
  const incompleteTravellerNumbers = application.travellers
    .map((traveller, travellerIndex) =>
      CompleteTravellerSchema.safeParse(traveller).success ? null : travellerIndex + 1,
    )
    .filter((travellerNumber): travellerNumber is number => travellerNumber !== null);
  if (incompleteTravellerNumbers.length > 0) {
    throw badRequest(
      `Traveller ${incompleteTravellerNumbers.join(", ")} still has incomplete passport details — go back to the Travellers step`,
    );
  }
  const countryProduct = await resolveCountryProduct(
    context,
    application.countryCode,
    application.productCode,
  );
  const uploadedDocuments = await listApplicationDocuments(context, applicationId);
  const missing = missingDocuments(countryProduct, application, uploadedDocuments);
  if (missing.length > 0) {
    throw badRequest(`Missing documents — ${missing.join(", ")}`);
  }

  const submittedApplication: Application = {
    ...application,
    status: "SUBMITTED",
    stepReached: "review",
    updatedAt: context.now().toISOString(),
  };
  await saveApplication(context, submittedApplication);
  await logActivity(
    context,
    "SUBMITTED",
    userId,
    applicationId,
    {
      countryCode: application.countryCode,
      travellerCount: application.travellers.length,
    },
    { actorEmail: userEmail, actorRole: "user" },
  );
  await context.email.send({
    toAddress: userEmail,
    subject: `Application received — ${application.countryCode} visa`,
    bodyText: [
      `We've received your ${application.countryCode} visa application (${applicationId}).`,
      "Our team will verify your documents and contact you for payment.",
      "Track progress anytime on your RGS dashboard.",
    ].join("\n"),
  });
  return submittedApplication;
}
