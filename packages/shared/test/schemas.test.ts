import { describe, expect, it } from "vitest";
import {
  ApplicationSchema,
  ApplicationDocumentSchema,
  ActivityEventSchema,
  TravellerSchema,
  UserSchema,
} from "../src/schemas.js";

const validTraveller = {
  fullName: "Asha Verma",
  dateOfBirth: "1992-04-18",
  nationality: "IN",
  passportNumber: "N1234567",
  passportIssueDate: "2020-01-10",
  passportExpiryDate: "2030-01-09",
};

const validApplication = {
  applicationId: "app_01J3ZTEST0000000000000000",
  userId: "user_01J3ZTEST000000000000000",
  countryCode: "AE",
  productCode: "AE_TOURIST_30D_SINGLE",
  travellers: [validTraveller],
  status: "DRAFT",
  stepReached: "travellers",
  amounts: { governmentFeeInr: 6500, serviceFeeInr: 1500, currency: "INR" },
  paymentStatus: "UNPAID",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
};

describe("UserSchema", () => {
  it("accepts a valid user", () => {
    const parsed = UserSchema.parse({
      userId: "user_01J3ZTEST000000000000000",
      email: "asha@example.com",
      fullName: "Asha Verma",
      phone: "+919810000000",
      createdAt: "2026-07-23T10:00:00.000Z",
    });
    expect(parsed.email).toBe("asha@example.com");
  });

  it("rejects an invalid email", () => {
    const result = UserSchema.safeParse({
      userId: "user_1",
      email: "not-an-email",
      fullName: "X",
      phone: "+919810000000",
      createdAt: "2026-07-23T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("TravellerSchema", () => {
  it("accepts a valid traveller", () => {
    expect(TravellerSchema.parse(validTraveller).nationality).toBe("IN");
  });

  it("rejects a lowercase or long nationality code", () => {
    expect(TravellerSchema.safeParse({ ...validTraveller, nationality: "ind" }).success).toBe(false);
  });

  it("rejects a non-ISO date of birth", () => {
    expect(TravellerSchema.safeParse({ ...validTraveller, dateOfBirth: "18/04/1992" }).success).toBe(false);
  });
});

describe("ApplicationSchema", () => {
  it("accepts a valid draft application", () => {
    expect(ApplicationSchema.parse(validApplication).status).toBe("DRAFT");
  });

  it("rejects an unknown status", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, status: "PENDING" }).success).toBe(false);
  });

  it("rejects an empty travellers list", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, travellers: [] }).success).toBe(false);
  });

  it("rejects an unknown payment status", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, paymentStatus: "PAID_ONLINE" }).success).toBe(false);
  });
});

describe("ApplicationDocumentSchema", () => {
  it("accepts a pending passport document", () => {
    const parsed = ApplicationDocumentSchema.parse({
      applicationId: validApplication.applicationId,
      docType: "PASSPORT_BIO",
      travellerIndex: 0,
      s3Key: "applications/app_1/traveller-0/PASSPORT_BIO.jpg",
      reviewStatus: "PENDING",
      uploadedAt: "2026-07-23T10:05:00.000Z",
    });
    expect(parsed.reviewStatus).toBe("PENDING");
  });

  it("requires rejectReason when reviewStatus is REJECTED", () => {
    const result = ApplicationDocumentSchema.safeParse({
      applicationId: validApplication.applicationId,
      docType: "PHOTO",
      travellerIndex: 0,
      s3Key: "applications/app_1/traveller-0/PHOTO.jpg",
      reviewStatus: "REJECTED",
      uploadedAt: "2026-07-23T10:05:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("ActivityEventSchema", () => {
  it("accepts a signup event without an application id", () => {
    const parsed = ActivityEventSchema.parse({
      eventId: "evt_01J3ZTEST0000000000000000",
      eventType: "SIGNED_UP",
      userId: "user_01J3ZTEST000000000000000",
      createdAt: "2026-07-23T10:00:00.000Z",
      meta: {},
    });
    expect(parsed.eventType).toBe("SIGNED_UP");
  });

  it("rejects an unknown event type", () => {
    const result = ActivityEventSchema.safeParse({
      eventId: "evt_1",
      eventType: "LOGGED_OUT",
      userId: "user_1",
      createdAt: "2026-07-23T10:00:00.000Z",
      meta: {},
    });
    expect(result.success).toBe(false);
  });
});
