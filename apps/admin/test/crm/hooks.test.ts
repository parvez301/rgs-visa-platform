import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { crmQueryKeys } from "../../src/crm/api/hooks";

describe("crmQueryKeys.ledger", () => {
  it("canonicalizes the status list order, so two callers filtering the same set share one cache entry", () => {
    expect(crmQueryKeys.ledger(["SUBMITTED", "NEW"], undefined)).toEqual(
      crmQueryKeys.ledger(["NEW", "SUBMITTED"], undefined),
    );
  });

  it("does not mutate the caller's status array", () => {
    const statuses: crm.CaseStatus[] = ["SUBMITTED", "NEW"];
    crmQueryKeys.ledger(statuses, undefined);
    expect(statuses).toEqual(["SUBMITTED", "NEW"]);
  });
});
