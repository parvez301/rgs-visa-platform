import type { Traveller } from "@rgs/shared";
import type { AppContext } from "../src/lib/context";
import { InMemoryTableClient } from "../src/lib/db";
import { InMemoryDocumentStore } from "../src/lib/documentStore";
import { InMemoryEmailSender } from "../src/lib/email";
import { createDraft, patchDraft } from "../src/domain/applications";
import { recordDocumentUpload } from "../src/domain/documents";

export interface TestContext extends AppContext {
  table: InMemoryTableClient;
  documents: InMemoryDocumentStore;
  email: InMemoryEmailSender;
  advanceClock(milliseconds: number): void;
}

export function buildTestContext(): TestContext {
  let currentTimeMs = new Date("2026-07-23T10:00:00.000Z").getTime();
  return {
    table: new InMemoryTableClient(),
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date(currentTimeMs),
    advanceClock(milliseconds: number) {
      currentTimeMs += milliseconds;
    },
  };
}

export const completeTraveller: Traveller = {
  fullName: "Asha Verma",
  dateOfBirth: "1992-04-18",
  nationality: "IN",
  passportNumber: "N1234567",
  passportIssueDate: "2020-01-10",
  passportExpiryDate: "2030-01-09",
};

export const completeEssentials = {
  intendedTravelDate: "2026-08-20",
  purposeOfTravel: "Tourism",
  contactPhone: "+919810000000",
  residentialAddress: "42 Green Park, New Delhi",
};

/** Creates a UAE draft filled to the point where submission should succeed. */
export async function createSubmittableUaeDraft(
  context: TestContext,
  userId = "user_1",
): Promise<string> {
  const draft = await createDraft(context, userId, "AE", `${userId}@example.com`);
  await patchDraft(context, userId, draft.applicationId, {
    travellers: [completeTraveller],
    essentials: completeEssentials,
    stepReached: "review",
  });
  for (const docType of ["PASSPORT_BIO", "PHOTO"] as const) {
    await recordDocumentUpload(
      context,
      userId,
      draft.applicationId,
      docType,
      0,
      `applications/${draft.applicationId}/traveller-0/${docType}.jpg`,
    );
  }
  return draft.applicationId;
}
