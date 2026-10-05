import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { crmQueryKeys } from "../../src/crm/api/hooks";
import { toServerLedgerFilters } from "../../src/crm/ledger/filters";

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

describe("crmQueryKeys.ledger filter fingerprint", () => {
  it("keeps the plain status/partner key distinct from a filtered one, so a new search refetches", () => {
    expect(crmQueryKeys.ledger(["NEW"], undefined, { search: "asha" })).not.toEqual(
      crmQueryKeys.ledger(["NEW"], undefined),
    );
    expect(crmQueryKeys.ledger(["NEW"], undefined, { search: "asha" })).not.toEqual(
      crmQueryKeys.ledger(["NEW"], undefined, { search: "asha b" }),
    );
    expect(crmQueryKeys.ledger(["NEW"], undefined, { destinationCountry: "AE" })).not.toEqual(
      crmQueryKeys.ledger(["NEW"], undefined, { destinationCountry: "GB" }),
    );
  });

  it("is order-insensitive for billing statuses and treats an empty filter set as no filters", () => {
    expect(crmQueryKeys.ledger([], undefined, { billingStatuses: ["PART_PAID", "BILL_SENT"] })).toEqual(
      crmQueryKeys.ledger([], undefined, { billingStatuses: ["BILL_SENT", "PART_PAID"] }),
    );
    expect(crmQueryKeys.ledger([], undefined, { billingStatuses: [] })).toEqual(crmQueryKeys.ledger([], undefined));
  });

  it("stays under the [crm, ledger] prefix the mutations invalidate by", () => {
    expect(crmQueryKeys.ledger([], "p1", { search: "x" }).slice(0, 2)).toEqual(["crm", "ledger"]);
  });
});

describe("toServerLedgerFilters", () => {
  it("resolves the __TODAY__ sentinel and drops blanks", () => {
    expect(
      toServerLedgerFilters(
        {
          search: "  asha ",
          destinationCountry: "AE",
          caseType: "VISA",
          billingStatuses: ["BILL_SENT"],
          appointmentDateOn: "__TODAY__",
          expectedCollectionDateOn: "2026-10-05",
        },
        "2026-10-01",
      ),
    ).toEqual({
      search: "asha",
      destinationCountry: "AE",
      caseType: "VISA",
      billingStatuses: ["BILL_SENT"],
      appointmentDateOn: "2026-10-01",
      expectedCollectionDateOn: "2026-10-05",
    });
    expect(toServerLedgerFilters({ search: "   ", billingStatuses: [] })).toEqual({});
  });
});
