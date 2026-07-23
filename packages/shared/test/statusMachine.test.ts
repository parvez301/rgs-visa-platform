import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, type ApplicationStatus } from "../src/statuses";
import {
  IllegalStatusTransitionError,
  LEGAL_STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
} from "../src/statusMachine";

const legalPairs: Array<[ApplicationStatus, ApplicationStatus]> = [
  ["DRAFT", "SUBMITTED"],
  ["SUBMITTED", "DOCS_VERIFIED"],
  ["DOCS_VERIFIED", "SENT_TO_IMMIGRATION"],
  ["SENT_TO_IMMIGRATION", "APPROVED"],
  ["SENT_TO_IMMIGRATION", "REJECTED"],
  ["APPROVED", "DELIVERED"],
];

describe("status machine", () => {
  it.each(legalPairs)("allows %s -> %s", (fromStatus, toStatus) => {
    expect(canTransition(fromStatus, toStatus)).toBe(true);
    expect(() => assertTransition(fromStatus, toStatus)).not.toThrow();
  });

  it("covers every status in the transition map", () => {
    expect(Object.keys(LEGAL_STATUS_TRANSITIONS).sort()).toEqual([...APPLICATION_STATUSES].sort());
  });

  it("rejects every pair that is not explicitly legal", () => {
    const legalKey = new Set(legalPairs.map(([fromStatus, toStatus]) => `${fromStatus}->${toStatus}`));
    for (const fromStatus of APPLICATION_STATUSES) {
      for (const toStatus of APPLICATION_STATUSES) {
        if (legalKey.has(`${fromStatus}->${toStatus}`)) continue;
        expect(canTransition(fromStatus, toStatus), `${fromStatus}->${toStatus}`).toBe(false);
      }
    }
  });

  it("terminal statuses REJECTED and DELIVERED allow nothing", () => {
    expect(LEGAL_STATUS_TRANSITIONS.REJECTED).toEqual([]);
    expect(LEGAL_STATUS_TRANSITIONS.DELIVERED).toEqual([]);
  });

  it("assertTransition throws a typed error with details", () => {
    try {
      assertTransition("DRAFT", "DELIVERED");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalStatusTransitionError);
      const transitionError = error as IllegalStatusTransitionError;
      expect(transitionError.fromStatus).toBe("DRAFT");
      expect(transitionError.toStatus).toBe("DELIVERED");
    }
  });
});
