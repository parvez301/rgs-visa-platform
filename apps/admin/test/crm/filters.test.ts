import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { applyFilters, applySort, type LedgerFilters, type LedgerSort } from "../../src/crm/ledger/filters";

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_0000",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12_000,
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  };
}

const emptyFilters: LedgerFilters = { statuses: [] };

describe("applyFilters", () => {
  it("matches caseRef case-insensitively and ignores surrounding space", () => {
    const rows = [buildRow({ caseId: "case_a", caseRef: "RGS-1001" }), buildRow({ caseId: "case_b", caseRef: "RGS-2002" })];

    const filtered = applyFilters(rows, { ...emptyFilters, search: "  rgs-10 " });

    expect(filtered.map((row) => row.caseId)).toEqual(["case_a"]);
  });

  it("matches the partner's canonical name, not the partner id", () => {
    const rows = [
      buildRow({ caseId: "case_a", partnerId: "partner_1" }),
      buildRow({ caseId: "case_b", partnerId: "partner_2" }),
    ];

    const filtered = applyFilters(rows, { ...emptyFilters, search: "skyline" }, { partner_1: "Skyline Travels" });

    expect(filtered.map((row) => row.caseId)).toEqual(["case_a"]);
  });

  it("matches a denormalised applicant name or passport on searchText", () => {
    const rows = [
      buildRow({ caseId: "case_asha", searchText: "asha rao m1234567" }),
      buildRow({ caseId: "case_other", searchText: "ravi singh a9988776" }),
      buildRow({ caseId: "case_no_search" }),
    ];

    expect(applyFilters(rows, { ...emptyFilters, search: "Asha" }).map((row) => row.caseId)).toEqual([
      "case_asha",
    ]);
    expect(applyFilters(rows, { ...emptyFilters, search: "m1234567" }).map((row) => row.caseId)).toEqual([
      "case_asha",
    ]);
  });

  it("filters by destination country and case type together", () => {
    const rows = [
      buildRow({ caseId: "case_ae_visa", destinationCountry: "AE", caseType: "VISA" }),
      buildRow({ caseId: "case_ae_attestation", destinationCountry: "AE", caseType: "ATTESTATION" }),
      buildRow({ caseId: "case_sg_visa", destinationCountry: "SG", caseType: "VISA" }),
    ];

    const filtered = applyFilters(rows, { ...emptyFilters, destinationCountry: "AE", caseType: "VISA" });

    // AND, not OR: matching just one of the two conditions is not enough.
    expect(filtered.map((row) => row.caseId)).toEqual(["case_ae_visa"]);
  });

  it("filters by billingStatus membership (the 'Awaiting payment' built-in view's own condition)", () => {
    const rows = [
      buildRow({ caseId: "case_sent", billingStatus: "BILL_SENT" }),
      buildRow({ caseId: "case_part", billingStatus: "PART_PAID" }),
      buildRow({ caseId: "case_paid", billingStatus: "PAID" }),
    ];

    const filtered = applyFilters(rows, { ...emptyFilters, billingStatuses: ["BILL_SENT", "PART_PAID"] });

    expect(filtered.map((row) => row.caseId).sort()).toEqual(["case_part", "case_sent"]);
  });

  it("filters by appointmentDateOn and expectedCollectionDateOn, resolving __TODAY__", () => {
    const rows = [
      buildRow({ caseId: "case_appt_today", appointmentDate: "2026-09-22" }),
      buildRow({ caseId: "case_collect_today", expectedCollectionDate: "2026-09-22" }),
      buildRow({
        caseId: "case_other_day",
        appointmentDate: "2026-09-23",
        expectedCollectionDate: "2026-09-23",
      }),
    ];

    expect(
      applyFilters(rows, { ...emptyFilters, appointmentDateOn: "__TODAY__" }, {}, "2026-09-22").map(
        (row) => row.caseId,
      ),
    ).toEqual(["case_appt_today"]);
    expect(
      applyFilters(
        rows,
        { ...emptyFilters, expectedCollectionDateOn: "2026-09-22" },
        {},
        "2026-09-22",
      ).map((row) => row.caseId),
    ).toEqual(["case_collect_today"]);
  });

  it("returns every row for an empty filter set rather than none", () => {
    const rows = [buildRow({ caseId: "case_a" }), buildRow({ caseId: "case_b" }), buildRow({ caseId: "case_c" })];

    const filtered = applyFilters(rows, emptyFilters);

    expect(filtered).toHaveLength(3);
  });

  it("does not filter by statuses or partnerId -- that pair is the server's job (spec §2.1)", () => {
    const rows = [buildRow({ caseId: "case_a", caseStatus: "CLOSED" })];

    // A caller that fetched rows for one status/partner and then re-applies
    // a DIFFERENT statuses/partnerId here must still see the row: this
    // function only re-checks the client-side fields.
    const filtered = applyFilters(rows, { statuses: ["NEW"], partnerId: "someone-else" });

    expect(filtered.map((row) => row.caseId)).toEqual(["case_a"]);
  });
});

describe("applySort", () => {
  it("sorts by receivedDate descending", () => {
    const rows = [
      buildRow({ caseId: "case_old", receivedDate: "2026-01-01" }),
      buildRow({ caseId: "case_new", receivedDate: "2026-06-01" }),
      buildRow({ caseId: "case_mid", receivedDate: "2026-03-01" }),
    ];

    const sorted = applySort(rows, { column: "receivedDate", direction: "desc" });

    expect(sorted.map((row) => row.caseId)).toEqual(["case_new", "case_mid", "case_old"]);
  });

  it("sorts totalInr numerically, not lexicographically", () => {
    const rows = [
      buildRow({ caseId: "case_2000", totalInr: 2_000 }),
      buildRow({ caseId: "case_10000", totalInr: 10_000 }),
      buildRow({ caseId: "case_300", totalInr: 300 }),
    ];

    const sorted = applySort(rows, { column: "totalInr", direction: "asc" });

    // A string sort would put "10000" before "2000" -- this must not.
    expect(sorted.map((row) => row.caseId)).toEqual(["case_300", "case_2000", "case_10000"]);
  });

  it("always sorts a row with no appointmentDate last, in both directions", () => {
    const rows = [
      buildRow({ caseId: "case_no_date", appointmentDate: undefined }),
      buildRow({ caseId: "case_early", appointmentDate: "2026-01-01" }),
      buildRow({ caseId: "case_late", appointmentDate: "2026-06-01" }),
    ];
    const sort: LedgerSort = { column: "appointmentDate", direction: "asc" };

    expect(applySort(rows, sort).map((row) => row.caseId)).toEqual(["case_early", "case_late", "case_no_date"]);
    expect(applySort(rows, { ...sort, direction: "desc" }).map((row) => row.caseId)).toEqual([
      "case_late",
      "case_early",
      "case_no_date",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [buildRow({ caseId: "case_b" }), buildRow({ caseId: "case_a" })];
    const original = [...rows];

    applySort(rows, { column: "caseRef", direction: "asc" });

    expect(rows).toEqual(original);
  });
});
