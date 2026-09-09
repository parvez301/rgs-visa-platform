import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";

describe("ReviewItemSchema", () => {
  const validItem = {
    tenantId: "rgs",
    reviewItemId: "rev_01",
    reason: "UNMAPPED_STATUS" as const,
    reviewStatus: "OPEN" as const,
    sourceSheet: "Mini CRM",
    sourceRow: 42,
    caseRef: "31376",
    fieldName: "Status",
    rawValue: "DEU/DEL/190126/",
    createdAt: "2026-07-23T10:00:00.000Z",
  };

  it("accepts a minimal open item and defaults the optional fields", () => {
    const parsed = crm.ReviewItemSchema.parse(validItem);
    expect(parsed.reviewStatus).toBe("OPEN");
    expect(parsed.proposedValue).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });

  it("keeps a proposed value and a confidence score when pass 2 supplies them", () => {
    const parsed = crm.ReviewItemSchema.parse({ ...validItem, proposedValue: "IN_PROGRESS", confidence: 0.82 });
    expect(parsed.proposedValue).toBe("IN_PROGRESS");
    expect(parsed.confidence).toBe(0.82);
  });

  it("rejects a reason that is not in the enum", () => {
    expect(() => crm.ReviewItemSchema.parse({ ...validItem, reason: "VIBES" })).toThrow();
  });

  it("rejects a confidence outside 0..1", () => {
    expect(() => crm.ReviewItemSchema.parse({ ...validItem, confidence: 1.4 })).toThrow();
  });

  it("requires sourceSheet and sourceRow so every item traces back to the workbook", () => {
    const { sourceRow: _omitted, ...withoutRow } = validItem;
    expect(() => crm.ReviewItemSchema.parse(withoutRow)).toThrow();
  });
});
