import type { MappedRow } from "./mapRow";

export interface ProposedGroup {
  caseRefs: string[];
  partnerName: string;
  destinationCountry: string;
  receivedDate: string;
}

/**
 * Ruling (task-8): absence never matches absence. `undefined === undefined`
 * (or `"" === ""`) must never count as a shared grouping key -- otherwise
 * every blank-partner, blank-date row in the workbook (188 of them, measured,
 * all contiguous by REF NO) would bucket together into one false group.
 */
function isPresentGroupingValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Ruling (task-8): REF NO adjacency is numeric, not lexicographic. A
 * `caseRef` that is not itself numeric has no defined neighbour, so it is
 * excluded rather than guessed at.
 */
function parseNumericCaseRef(caseRef: string): number | undefined {
  const numericCaseRef = Number(caseRef);
  return Number.isFinite(numericCaseRef) ? numericCaseRef : undefined;
}

/**
 * Spec §9: same partner + country + received date + adjacent REF NO numbers
 * are PROPOSED as one case. Proposals are reviewed, never auto-applied --
 * this function returns candidates and writes nothing.
 */
export function proposeGroups(mappedRows: MappedRow[]): ProposedGroup[] {
  const rowsByGroupingKey = new Map<string, MappedRow[]>();

  for (const mappedRow of mappedRows) {
    const { partnerName, caseDraft } = mappedRow;
    const { destinationCountry, receivedDate } = caseDraft;

    if (
      !isPresentGroupingValue(partnerName) ||
      !isPresentGroupingValue(destinationCountry) ||
      !isPresentGroupingValue(receivedDate)
    ) {
      continue; // a group requires three present, equal values -- absence never matches absence
    }
    if (parseNumericCaseRef(mappedRow.caseRef) === undefined) {
      continue; // no numeric REF NO, no defined neighbour to be adjacent to
    }

    const groupingKey = `${partnerName}|${destinationCountry}|${receivedDate}`;
    const rowsForKey = rowsByGroupingKey.get(groupingKey);
    if (rowsForKey === undefined) {
      rowsByGroupingKey.set(groupingKey, [mappedRow]);
    } else {
      rowsForKey.push(mappedRow);
    }
  }

  const proposedGroups: ProposedGroup[] = [];

  for (const rowsForKey of rowsByGroupingKey.values()) {
    if (rowsForKey.length < 2) {
      continue;
    }

    const rowsSortedByCaseRef = [...rowsForKey].sort(
      (leftRow, rightRow) => parseNumericCaseRef(leftRow.caseRef)! - parseNumericCaseRef(rightRow.caseRef)!,
    );

    let runStartIndex = 0;
    for (let currentIndex = 1; currentIndex <= rowsSortedByCaseRef.length; currentIndex += 1) {
      const previousCaseRefNumber = parseNumericCaseRef(rowsSortedByCaseRef[currentIndex - 1]!.caseRef)!;
      const currentCaseRefNumber =
        currentIndex < rowsSortedByCaseRef.length
          ? parseNumericCaseRef(rowsSortedByCaseRef[currentIndex]!.caseRef)!
          : Number.NaN;
      const isRunBoundary = currentCaseRefNumber !== previousCaseRefNumber + 1;

      if (isRunBoundary) {
        const adjacentRun = rowsSortedByCaseRef.slice(runStartIndex, currentIndex);
        if (adjacentRun.length >= 2) {
          const firstRowInRun = adjacentRun[0]!;
          proposedGroups.push({
            caseRefs: adjacentRun.map((runRow) => runRow.caseRef),
            partnerName: firstRowInRun.partnerName,
            destinationCountry: firstRowInRun.caseDraft.destinationCountry,
            // Not `?? ""`: every row in this bucket passed
            // isPresentGroupingValue(receivedDate) above, so absence is not
            // reachable here. A fallback that cannot fire reads as if a group
            // could have a blank received date, which is the exact confusion
            // the "absence never matches absence" ruling exists to prevent.
            receivedDate: firstRowInRun.caseDraft.receivedDate!,
          });
        }
        runStartIndex = currentIndex;
      }
    }
  }

  return proposedGroups;
}
