import { describe, expect, it } from "vitest";
import { proposeGroups } from "../src/groupCases";
import type { MappedRow } from "../src/mapRow";

function rowFor(caseRef: string, receivedDate: string, partnerName = "VWI Mumbai"): MappedRow {
  return {
    caseRef,
    partnerName,
    caseDraft: { destinationCountry: "TR", receivedDate },
  } as MappedRow;
}

// Ruling (task-8): a row whose partnerName / destinationCountry / receivedDate
// is missing has no grouping key at all -- distinct from rowFor's "" received
// date above, this also blanks partnerName and destinationCountry, and leaves
// receivedDate unset (undefined) the way Task 7 actually leaves a blank cell.
function rowForBlankGroupingKey(caseRef: string): MappedRow {
  return {
    caseRef,
    partnerName: "",
    caseDraft: { destinationCountry: "" },
  } as MappedRow;
}

describe("proposeGroups", () => {
  it("proposes adjacent REF NOs sharing partner, country and received date", () => {
    const proposals = proposeGroups([
      rowFor("31376", "2025-01-02"),
      rowFor("31377", "2025-01-02"),
      rowFor("31378", "2025-01-02"),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.caseRefs).toEqual(["31376", "31377", "31378"]);
  });

  it("does not group non-adjacent REF NOs", () => {
    expect(proposeGroups([rowFor("31376", "2025-01-02"), rowFor("31380", "2025-01-02")])).toEqual([]);
  });

  it("does not group across different partners", () => {
    expect(
      proposeGroups([rowFor("31376", "2025-01-02", "VWI Mumbai"), rowFor("31377", "2025-01-02", "Other Agency")]),
    ).toEqual([]);
  });

  it("does not group rows with no received date", () => {
    expect(proposeGroups([rowFor("31376", ""), rowFor("31377", "")])).toEqual([]);
  });

  // Ruling (task-8): absence never matches absence. Several rows with blank
  // partner, blank country and blank (unset) received date but adjacent REF
  // NOs must NOT be proposed as a group -- that is exactly the 188-row false
  // group the ruling exists to prevent.
  it("refuses to group rows whose grouping key is missing, even with adjacent REF NOs", () => {
    const proposals = proposeGroups([
      rowForBlankGroupingKey("31500"),
      rowForBlankGroupingKey("31501"),
      rowForBlankGroupingKey("31502"),
    ]);
    expect(proposals).toEqual([]);
  });

  // Ruling (task-8): REF NO adjacency is numeric, not lexicographic -- and a
  // non-numeric caseRef has no defined neighbour at all, so it must never be
  // guessed into a group.
  it("does not group a non-numeric caseRef, even when it sorts lexicographically next to numeric ones", () => {
    const proposals = proposeGroups([
      rowFor("31376", "2025-01-02"),
      rowFor("ABC123", "2025-01-02"),
      rowFor("31377", "2025-01-02"),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.caseRefs).toEqual(["31376", "31377"]);
  });
});
