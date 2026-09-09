import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "@rgs/api/src/lib/context";
import { CorruptRecordError, badRequest } from "@rgs/api/src/lib/errors";
import { newId } from "@rgs/api/src/lib/ids";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCasesByStatus } from "@rgs/api/src/domain/crm/cases";
import { createPartner, findPartnerByName } from "@rgs/api/src/domain/crm/partners";
import {
  findTravellerByName,
  findTravellerByPassport,
  upsertTraveller,
} from "@rgs/api/src/domain/crm/travellers";
import { recordReviewItem } from "@rgs/api/src/domain/crm/reviewQueue";
import type { JoinedContactDetails } from "./joinPhones";
import type { MappedCaseDraft, MappedRow, PendingReviewItem } from "./mapRow";
import type { ProposedGroup } from "./groupCases";
import type { ResidueResolution, ResidueResolver } from "./residueResolver";
import { MINI_CRM_SHEET_NAME } from "./readWorkbook";

export interface ImportSummary {
  rowsRead: number;
  casesCreated: number;
  casesSkippedAlreadyImported: number;
  partnersCreated: number;
  partnersReused: number;
  travellersCreated: number;
  travellersReused: number;
  reviewItemsRecorded: number;
  groupsProposed: number;
  createdCaseIds: string[];
}

export interface RunImportInput {
  mappedRows: MappedRow[];
  contactDetails: Map<string, JoinedContactDetails>;
  proposedGroups: ProposedGroup[];
  residueResolver: ResidueResolver;
  actorEmail: string;
  dryRun: boolean;
}

/**
 * Ruling (task-9, blank-partner blocker): `createPartner` rejects a name that
 * normalizes to no canonical key, and `CaseSchema.partnerId` cannot be empty.
 * 207 of 7,156 real rows carry a blank partner name. One sentinel partner
 * absorbs all of them, created through the ordinary find-then-create path so
 * a re-run finds it instead of conflicting.
 */
const SENTINEL_PARTNER_CANONICAL_NAME = "(no referrer recorded)";
// Non-null: the sentinel string is a non-blank literal we control, so
// normalizePartnerName always yields a real canonical key for it.
const SENTINEL_PARTNER_CANONICAL_KEY: string =
  crm.normalizePartnerName(SENTINEL_PARTNER_CANONICAL_NAME).canonicalKey!;

/** Spec §9: a pass-2 answer at or above this confidence auto-applies; below it queues. */
const RESIDUE_AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.9;

/**
 * `listCasesByStatus`'s own default limit is 50 -- comfortably below a single
 * tenant's per-status case count on the real workbook. Sweeping with the
 * default would silently miss every case past the first page and re-import
 * it on a "second" run that is really just page 2 of the first.
 */
const CASE_REF_SWEEP_PAGE_LIMIT = 1_000_000;

/** Every migrated row names exactly one known applicant -- its own traveller. */
const PRIMARY_APPLICANT_REF = "1";

/**
 * `CrmCaseSchema.destinationCountry` and `.receivedDate` are both required,
 * but the workbook does not always supply them -- measured on the real file:
 * 452 of 7,156 rows leave `destinationCountry` empty (207 blank Country
 * cells, 245 present-but-unmapped) and 225 leave `receivedDate` unset (blank
 * or unparseable "C" cells). Unhandled, either would abort the run at
 * `CrmCaseSchema.parse` the same way the blank-partner defect would have --
 * it just was not named in the controller's ruling. Both are substituted
 * SILENTLY (no review item): spec §6 already treats "blank" as "not
 * recorded, not a defect", and a placeholder forced by the schema is not new
 * information for a human -- the country/date column's own review item (when
 * one exists, e.g. a present-but-unmapped country) already surfaces the real
 * problem. Sentinels are chosen to be unmistakably synthetic:
 * "ZZ" is ISO-3166's reserved user-assigned "unknown" code; "1970-01-01"
 * predates RGS's operation entirely.
 */
const UNKNOWN_DESTINATION_COUNTRY_SENTINEL = "ZZ";
const UNKNOWN_RECEIVED_DATE_SENTINEL = "1970-01-01";

/**
 * `CrmTravellerSchema.fullName` is `z.string().trim().min(1)`, but the
 * workbook does not always name an applicant -- measured on the real file:
 * 189 of 7,156 rows leave `travellerFullName` blank. Unhandled, `upsertTraveller`
 * raises a `badRequest` (caught internally, but never by `runImport`) that
 * aborts the entire run at the first such row.
 *
 * This is NOT the same shape as the blank-partner defect. The partner
 * sentinel deliberately merges all 207 blank-partner cases onto one shared
 * partner record -- correct there, because "who referred this case" really
 * is unknown-and-the-same-unknown for all of them. A traveller is a
 * different person on every row; sharing one placeholder name would run
 * every blank-name row through `findTravellerByName`'s fuzzy match and
 * silently merge 189 unrelated applicants into a single traveller record
 * (wrong case history, wrong phone, wrong passport on lookup). So each row
 * gets its OWN placeholder, keyed on `sourceRow` (stable and unique within
 * "Mini CRM", so idempotent across a re-run without merging anyone).
 *
 * No review item: like the country/date sentinels above, this is a
 * mechanical schema-satisfaction step, not new information -- the
 * placeholder itself is unmistakably synthetic and visible on the case's
 * own traveller field, the same way "ZZ" or "1970-01-01" are.
 */
function unknownTravellerFullNameSentinel(sourceRow: number): string {
  return `(name not recorded, row ${sourceRow})`;
}

function isBlankTravellerFullName(travellerFullName: string): boolean {
  return travellerFullName.trim() === "";
}

interface PartnerResolution {
  partnerId: string;
  created: boolean;
  /** True when the row's raw partner name was blank/unnormalizable and the sentinel partner was used instead. */
  usedSentinel: boolean;
}

interface TravellerResolution {
  travellerId: string;
  created: boolean;
}

/** Per-row outcome of the duplicate-`caseRef` ruling (task-9). */
interface DuplicateCaseRefResolution {
  effectiveCaseRef: string;
  /** `sourceRow`s of every OTHER row claiming the same raw `caseRef`. */
  otherSourceRows: number[];
}

/**
 * A pending review item that survived pass-2, optionally carrying the
 * resolver's own answer. `PendingReviewItem` itself has no `confidence`
 * field (pass 1 never produces one); this is where a pass-2 answer below the
 * auto-apply threshold attaches its `proposedValue` and `confidence` so a
 * human sees exactly what the resolver suggested.
 */
type ResolvedPendingReviewItem = PendingReviewItem & { confidence?: number };

interface ResidueApplicationResult {
  caseDraft: MappedCaseDraft;
  reviewItemsToRecord: ResolvedPendingReviewItem[];
}

/**
 * Ruling (task-9): `caseRef` is not unique -- 18 of 7,156 real refs are
 * duplicated, 14 spanning two different partners. Identity is `caseRef` for
 * the row with the lowest `sourceRow`; every later claimant imports under
 * the derived ref `${caseRef}-R${sourceRow}` instead of overwriting. Both the
 * first and every later row also carry the OTHER rows' source rows, so the
 * importer can raise one `DUPLICATE_REF` review item per row.
 *
 * Keyed by `sourceRow` rather than the `MappedRow` object itself: sourceRow
 * is the workbook's own unique row number, a plain, comparable, storable key.
 */
function resolveDuplicateCaseRefs(mappedRows: readonly MappedRow[]): Map<number, DuplicateCaseRefResolution> {
  const rowsByRawCaseRef = new Map<string, MappedRow[]>();
  for (const mappedRow of mappedRows) {
    const rowsForRef = rowsByRawCaseRef.get(mappedRow.caseRef);
    if (rowsForRef === undefined) {
      rowsByRawCaseRef.set(mappedRow.caseRef, [mappedRow]);
    } else {
      rowsForRef.push(mappedRow);
    }
  }

  const resolutionBySourceRow = new Map<number, DuplicateCaseRefResolution>();
  for (const rowsForRef of rowsByRawCaseRef.values()) {
    const rowsSortedBySourceRow = [...rowsForRef].sort(
      (earlierRow, laterRow) => earlierRow.sourceRow - laterRow.sourceRow,
    );
    const firstClaimingRow = rowsSortedBySourceRow[0]!;
    for (const claimingRow of rowsSortedBySourceRow) {
      const otherSourceRows = rowsSortedBySourceRow
        .filter((otherRow) => otherRow.sourceRow !== claimingRow.sourceRow)
        .map((otherRow) => otherRow.sourceRow);
      const effectiveCaseRef =
        claimingRow.sourceRow === firstClaimingRow.sourceRow
          ? claimingRow.caseRef
          : `${claimingRow.caseRef}-R${claimingRow.sourceRow}`;
      resolutionBySourceRow.set(claimingRow.sourceRow, { effectiveCaseRef, otherSourceRows });
    }
  }
  return resolutionBySourceRow;
}

/**
 * Ruling (task-9): idempotency is keyed on `caseRef` (here, the effective
 * ref after duplicate resolution), and `caseRef` carries no index yet -- a
 * gap Plan 5 is left to close. Until then, the only way to know what a prior
 * run already imported is to sweep every case status; sweeping only the
 * default-limited first page of one status would under-count and re-import.
 */
async function sweepAlreadyImportedCaseRefs(
  context: AppContext,
  tenantId: string,
): Promise<Set<string>> {
  const alreadyImportedCaseRefs = new Set<string>();
  for (const caseStatus of crm.CASE_STATUSES) {
    const { cases } = await listCasesByStatus(context, tenantId, caseStatus, CASE_REF_SWEEP_PAGE_LIMIT);
    for (const existingCase of cases) {
      alreadyImportedCaseRefs.add(existingCase.caseRef);
    }
  }
  return alreadyImportedCaseRefs;
}

/**
 * Ruling (task-9): resolve each partner once per canonical key per run via
 * an in-run `Map<canonicalKey, partnerId>`, rather than a full partner-list
 * scan on every one of 6,949 rows. `findPartnerByName` is still called on the
 * first sighting of a key -- an earlier run's partner must still be found --
 * and the raw name is passed through to `findPartnerByName`/`createPartner`
 * unchanged; the API domain canonicalizes internally, and pre-normalizing
 * here would break alias matching.
 *
 * A blank (or otherwise unnormalizable) partner name routes to the one
 * sentinel partner instead, per the blank-partner ruling.
 */
async function resolvePartner(
  context: AppContext,
  tenantId: string,
  rawPartnerName: string,
  actorEmail: string,
  dryRun: boolean,
  partnerIdByCanonicalKey: Map<string, string>,
): Promise<PartnerResolution> {
  const normalizedPartnerName = crm.normalizePartnerName(rawPartnerName);
  const isUnnormalizable = normalizedPartnerName.canonicalKey === null;
  const canonicalKeyForCache: string = normalizedPartnerName.canonicalKey ?? SENTINEL_PARTNER_CANONICAL_KEY;
  const partnerNameToResolve = isUnnormalizable ? SENTINEL_PARTNER_CANONICAL_NAME : rawPartnerName;

  const cachedPartnerId = partnerIdByCanonicalKey.get(canonicalKeyForCache);
  if (cachedPartnerId !== undefined) {
    return { partnerId: cachedPartnerId, created: false, usedSentinel: isUnnormalizable };
  }

  const existingPartner = await findPartnerByName(context, tenantId, partnerNameToResolve);
  if (existingPartner !== undefined) {
    partnerIdByCanonicalKey.set(canonicalKeyForCache, existingPartner.partnerId);
    return { partnerId: existingPartner.partnerId, created: false, usedSentinel: isUnnormalizable };
  }

  if (dryRun) {
    const placeholderPartnerId = newId("prt", context.now().getTime());
    partnerIdByCanonicalKey.set(canonicalKeyForCache, placeholderPartnerId);
    return { partnerId: placeholderPartnerId, created: true, usedSentinel: isUnnormalizable };
  }

  const createdPartner = await createPartner(
    context,
    tenantId,
    {
      canonicalName: partnerNameToResolve,
      // Ruling (task-9): the sentinel's type is an explicit, one-off choice
      // ("(no referrer recorded)" is RGS's own direct business, not an
      // agency). Every other partner keeps `normalizePartnerName`'s own
      // inference -- setting `partnerType` for those would duplicate the
      // domain's own canonicalization logic and risk disagreeing with it.
      ...(isUnnormalizable ? { partnerType: "DIRECT" as crm.PartnerType } : {}),
    },
    actorEmail,
  );
  partnerIdByCanonicalKey.set(canonicalKeyForCache, createdPartner.partnerId);
  return { partnerId: createdPartner.partnerId, created: true, usedSentinel: isUnnormalizable };
}

/**
 * Brief step (c): passport first, then normalized full name, then create.
 * The traveller's `phone` (from the `2025 YEAR` join) is recorded only when a
 * NEW traveller is created -- an existing traveller is returned as-is,
 * mirroring `upsertTraveller`'s own no-merge behaviour.
 */
async function resolveTraveller(
  context: AppContext,
  tenantId: string,
  fullName: string,
  passportNumber: string | undefined,
  phone: string | undefined,
  dryRun: boolean,
): Promise<TravellerResolution> {
  if (passportNumber !== undefined) {
    const existingByPassport = await findTravellerByPassport(context, tenantId, passportNumber);
    if (existingByPassport !== undefined) {
      return { travellerId: existingByPassport.travellerId, created: false };
    }
  }

  const existingByName = await findTravellerByName(context, tenantId, fullName);
  if (existingByName !== undefined) {
    return { travellerId: existingByName.travellerId, created: false };
  }

  if (dryRun) {
    return { travellerId: newId("trv", context.now().getTime()), created: true };
  }

  const createdTraveller = await upsertTraveller(context, tenantId, {
    fullName,
    ...(passportNumber !== undefined ? { passportNumber } : {}),
    ...(phone !== undefined ? { phone } : {}),
  });
  return { travellerId: createdTraveller.travellerId, created: true };
}

/**
 * Where a resolved (>= 0.9 confidence) pass-2 answer lands. Keyed by the SAME
 * `fieldName` `mapRow` already puts on the `PendingReviewItem` (the sheet's
 * own column label), so a resolution can only ever answer a pending item
 * that named a real column.
 *
 * `REFRENCE` (the partner column) is deliberately NOT auto-applied here:
 * reassigning which partner a case belongs to has bigger consequences
 * (billing, reporting) than a field correction, so even a high-confidence
 * partner answer still lands as a review item (carrying its proposedValue
 * and confidence) rather than silently rewiring the case's partner.
 *
 * An answer of the wrong shape for its field (e.g. a `caseStatus` that is
 * not a real `CaseStatus`) is still caught: `CrmCaseSchema.parse` validates
 * the whole case before it is written, the same safety net every other
 * write path relies on.
 */
function applyResolvedFieldToDraft(
  caseDraft: MappedCaseDraft,
  fieldName: string,
  proposedValue: string,
): boolean {
  switch (fieldName) {
    case "Country":
      caseDraft.destinationCountry = proposedValue;
      return true;
    case "Visa Type":
      caseDraft.visaType = proposedValue as crm.VisaType;
      return true;
    case "Entries":
      caseDraft.entryType = proposedValue as crm.EntryType;
      return true;
    case "Status":
      caseDraft.caseStatus = proposedValue as crm.CaseStatus;
      return true;
    case "C":
      caseDraft.receivedDate = proposedValue;
      return true;
    case "Sub Date":
      caseDraft.submissionDate = proposedValue;
      return true;
    case "Collection":
      caseDraft.expectedCollectionDate = proposedValue;
      return true;
    default:
      return false;
  }
}

/**
 * Brief step (d): offers the row's pending review items to the pass-2 seam.
 * `passthroughResidueResolver` always returns `[]`, so every pending item
 * flows straight through today; Plan 4's real resolver is what will ever
 * populate `resolutions`. Not implemented here on purpose -- only wired.
 */
async function resolveResidue(
  mappedRow: MappedRow,
  residueResolver: ResidueResolver,
): Promise<ResidueApplicationResult> {
  const caseDraft: MappedCaseDraft = { ...mappedRow.caseDraft };

  if (mappedRow.reviewItems.length === 0) {
    return { caseDraft, reviewItemsToRecord: [] };
  }

  const resolutions = await residueResolver.resolve(mappedRow, mappedRow.reviewItems);
  const resolutionByFieldName = new Map<string, ResidueResolution>(
    resolutions.map((resolution) => [resolution.fieldName, resolution]),
  );

  const reviewItemsToRecord: ResolvedPendingReviewItem[] = [];
  for (const pendingReviewItem of mappedRow.reviewItems) {
    const resolution = resolutionByFieldName.get(pendingReviewItem.fieldName);
    if (
      resolution !== undefined &&
      resolution.confidence >= RESIDUE_AUTO_APPLY_CONFIDENCE_THRESHOLD &&
      applyResolvedFieldToDraft(caseDraft, pendingReviewItem.fieldName, resolution.proposedValue)
    ) {
      continue;
    }
    reviewItemsToRecord.push(
      resolution === undefined
        ? pendingReviewItem
        : { ...pendingReviewItem, proposedValue: resolution.proposedValue, confidence: resolution.confidence },
    );
  }

  return { caseDraft, reviewItemsToRecord };
}

/** The earliest (by `sourceRow`) mapped row naming any of a group's case refs. */
function earliestMappedRowForCaseRefs(
  mappedRows: readonly MappedRow[],
  caseRefs: readonly string[],
): MappedRow | undefined {
  const caseRefSet = new Set(caseRefs);
  let earliestRow: MappedRow | undefined;
  for (const mappedRow of mappedRows) {
    if (!caseRefSet.has(mappedRow.caseRef)) continue;
    if (earliestRow === undefined || mappedRow.sourceRow < earliestRow.sourceRow) {
      earliestRow = mappedRow;
    }
  }
  return earliestRow;
}

/**
 * Records one review item and counts it, honouring `dryRun` the same way
 * every other write in the run does: the write is skipped, the counter is not.
 */
async function recordReviewItemAndCount(
  context: AppContext,
  tenantId: string,
  dryRun: boolean,
  summary: ImportSummary,
  reviewItemInput: Parameters<typeof recordReviewItem>[2],
): Promise<void> {
  if (!dryRun) {
    await recordReviewItem(context, tenantId, reviewItemInput);
  }
  summary.reviewItemsRecorded += 1;
}

export async function runImport(
  context: AppContext,
  tenantId: string,
  input: RunImportInput,
): Promise<ImportSummary> {
  const alreadyImportedCaseRefs = await sweepAlreadyImportedCaseRefs(context, tenantId);
  const caseRefResolutionBySourceRow = resolveDuplicateCaseRefs(input.mappedRows);
  const partnerIdByCanonicalKey = new Map<string, string>();

  const summary: ImportSummary = {
    rowsRead: input.mappedRows.length,
    casesCreated: 0,
    casesSkippedAlreadyImported: 0,
    partnersCreated: 0,
    partnersReused: 0,
    travellersCreated: 0,
    travellersReused: 0,
    reviewItemsRecorded: 0,
    groupsProposed: input.proposedGroups.length,
    createdCaseIds: [],
  };

  for (const mappedRow of input.mappedRows) {
    // Guaranteed present: built from this exact array, keyed by sourceRow.
    const caseRefResolution = caseRefResolutionBySourceRow.get(mappedRow.sourceRow)!;

    let partnerResolution: PartnerResolution;
    try {
      partnerResolution = await resolvePartner(
        context,
        tenantId,
        mappedRow.partnerName,
        input.actorEmail,
        input.dryRun,
        partnerIdByCanonicalKey,
      );
    } catch (error) {
      // A stored partner row that will not reassemble answers 409
      // CORRUPT_RECORD from `createPartner`'s own duplicate-name lookup --
      // a write-path failure, not a read-path one. One corrupt partner must
      // not abort the whole run: park this row for review and move on,
      // exactly the "skip the bad row, name it" pattern used everywhere
      // else a corrupt CRM record is read.
      if (error instanceof CorruptRecordError) {
        await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
          reason: "UNMAPPED_PARTNER",
          sourceSheet: mappedRow.sourceSheet,
          sourceRow: mappedRow.sourceRow,
          caseRef: mappedRow.caseRef,
          fieldName: "REFRENCE",
          rawValue: mappedRow.partnerName,
          detail: `Blocked by a corrupt stored partner record: ${error.message}`,
        });
        continue;
      }
      throw error;
    }
    if (partnerResolution.created) {
      summary.partnersCreated += 1;
    } else {
      summary.partnersReused += 1;
    }

    if (alreadyImportedCaseRefs.has(caseRefResolution.effectiveCaseRef)) {
      summary.casesSkippedAlreadyImported += 1;
      continue;
    }

    // `joinPhones` keys its result by the RAW caseRef, same as pass 1 uses it
    // throughout -- not the effective (duplicate-safe) ref.
    const contactDetailsForRow = input.contactDetails.get(mappedRow.caseRef);

    const travellerFullNameForCase = isBlankTravellerFullName(mappedRow.travellerFullName)
      ? unknownTravellerFullNameSentinel(mappedRow.sourceRow)
      : mappedRow.travellerFullName;
    const travellerResolution = await resolveTraveller(
      context,
      tenantId,
      travellerFullNameForCase,
      mappedRow.passportNumber,
      contactDetailsForRow?.phone,
      input.dryRun,
    );
    if (travellerResolution.created) {
      summary.travellersCreated += 1;
    } else {
      summary.travellersReused += 1;
    }

    const residueResult = await resolveResidue(mappedRow, input.residueResolver);
    const resolvedCaseDraft = residueResult.caseDraft;

    // Nothing is discarded: every value with no dedicated schema field lands
    // in legacyRaw, but only when it is actually present -- an applicant
    // count of 1 or an absent Status note is not information being lost.
    const legacyRaw: Record<string, string> = { ...mappedRow.legacyRaw };
    if (contactDetailsForRow?.flaggedPhoneRaw !== undefined) {
      legacyRaw["Phone"] = contactDetailsForRow.flaggedPhoneRaw;
    }
    if (resolvedCaseDraft.note !== undefined) {
      legacyRaw["Status note"] = resolvedCaseDraft.note;
    }
    if (mappedRow.applicantCount > 1) {
      legacyRaw["No."] = String(mappedRow.applicantCount);
    }

    const destinationCountryForCase =
      resolvedCaseDraft.destinationCountry === ""
        ? UNKNOWN_DESTINATION_COUNTRY_SENTINEL
        : resolvedCaseDraft.destinationCountry;
    const receivedDateForCase = resolvedCaseDraft.receivedDate ?? UNKNOWN_RECEIVED_DATE_SENTINEL;

    // `CrmCaseSchema` refines that only a VISA case may carry a visaType.
    // `mapRow` picks `caseType` from Status (a "Payment Only" row -> OTHER)
    // independently of `visaType` from the Visa Type column, so the two can
    // disagree -- measured on the real workbook: 16 of 7,156 rows carry a
    // non-VISA caseType (always OTHER, always from "Payment Only") alongside
    // a real Visa Type value. Unhandled this aborts the run at
    // CrmCaseSchema.parse. Resolved the same way Task 7 resolved the
    // analogous Country-hint-vs-explicit-column conflict: the explicit
    // caseType signal wins and the visaType is dropped from the structured
    // field silently -- but not discarded, since it survives in legacyRaw.
    const visaTypeForCase =
      resolvedCaseDraft.caseType === "VISA" ? resolvedCaseDraft.visaType : undefined;
    if (resolvedCaseDraft.caseType !== "VISA" && resolvedCaseDraft.visaType !== undefined) {
      legacyRaw["Visa Type"] = resolvedCaseDraft.visaType;
    }

    const nowIso = context.now().toISOString();
    let migratedCase: crm.CrmCase;
    try {
      migratedCase = crm.CrmCaseSchema.parse({
        tenantId,
        caseId: newId("case", context.now().getTime()),
        caseRef: caseRefResolution.effectiveCaseRef,
        caseType: resolvedCaseDraft.caseType,
        partnerId: partnerResolution.partnerId,
        destinationCountry: destinationCountryForCase,
        ...(visaTypeForCase !== undefined ? { visaType: visaTypeForCase } : {}),
        ...(resolvedCaseDraft.entryType !== undefined ? { entryType: resolvedCaseDraft.entryType } : {}),
        ...(resolvedCaseDraft.processing !== undefined ? { processing: resolvedCaseDraft.processing } : {}),
        ...(resolvedCaseDraft.validity !== undefined ? { validity: resolvedCaseDraft.validity } : {}),
        caseStatus: resolvedCaseDraft.caseStatus,
        // Ruling/brief: migrated rows carry no billing evidence. UNKNOWN,
        // never UNBILLED -- the billing_overdue watchdog excludes UNKNOWN.
        billingStatus: "UNKNOWN",
        receivedDate: receivedDateForCase,
        ...(resolvedCaseDraft.submissionDate !== undefined
          ? { submissionDate: resolvedCaseDraft.submissionDate }
          : {}),
        ...(resolvedCaseDraft.expectedCollectionDate !== undefined
          ? { expectedCollectionDate: resolvedCaseDraft.expectedCollectionDate }
          : {}),
        applicants: [
          {
            applicantRef: PRIMARY_APPLICANT_REF,
            travellerId: travellerResolution.travellerId,
            ...(mappedRow.passportNumber !== undefined
              ? { passportNumber: mappedRow.passportNumber }
              : {}),
            custody: resolvedCaseDraft.custody,
            outcome: resolvedCaseDraft.outcome,
            ...(resolvedCaseDraft.courierMode !== undefined
              ? { courierMode: resolvedCaseDraft.courierMode }
              : {}),
            ...(contactDetailsForRow?.trackingNumber !== undefined
              ? { trackingNumber: contactDetailsForRow.trackingNumber }
              : {}),
          },
        ],
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        legacyRaw,
        createdAt: nowIso,
        updatedAt: nowIso,
        ...(input.actorEmail !== "" ? { createdByEmail: input.actorEmail } : {}),
      });
    } catch (error) {
      if (error instanceof ZodError) {
        const firstIssue = error.issues[0];
        throw badRequest(
          `Row ${mappedRow.sourceRow} (REF ${mappedRow.caseRef}): ${
            firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "invalid migrated case"
          }`,
        );
      }
      throw error;
    }

    // Migrated cases are never dragged by the derived-status rules: write
    // straight through the store, never through changeCaseStatus /
    // changeApplicantCustody / changeBillingStatus / changeApplicantOutcome.
    if (!input.dryRun) {
      await writeCase(context, migratedCase);
    }
    summary.casesCreated += 1;
    summary.createdCaseIds.push(migratedCase.caseId);

    for (const pendingReviewItem of residueResult.reviewItemsToRecord) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: pendingReviewItem.reason,
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: pendingReviewItem.fieldName,
        rawValue: pendingReviewItem.rawValue,
        ...(pendingReviewItem.proposedValue !== undefined
          ? { proposedValue: pendingReviewItem.proposedValue }
          : {}),
        ...(pendingReviewItem.confidence !== undefined ? { confidence: pendingReviewItem.confidence } : {}),
        ...(pendingReviewItem.detail !== undefined ? { detail: pendingReviewItem.detail } : {}),
      });
    }

    if (caseRefResolution.otherSourceRows.length > 0) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "DUPLICATE_REF",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "REF NO.",
        rawValue: mappedRow.caseRef,
        detail: `REF NO. ${mappedRow.caseRef} is also claimed by source row(s) ${caseRefResolution.otherSourceRows.join(", ")}. Confirm whether this is the same case entered twice or distinct cases that happen to share a REF NO.`,
      });
    }

    // Ruling (task-9, blank-partner blocker): every case attached to the
    // sentinel partner also raises a review item so all 207 (measured) are
    // visible and reassignable by a human.
    if (partnerResolution.usedSentinel) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "UNMAPPED_PARTNER",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "REFRENCE",
        rawValue: mappedRow.partnerName,
        detail: `Partner was not recorded; case filed under the sentinel partner "${SENTINEL_PARTNER_CANONICAL_NAME}" pending reassignment.`,
      });
    }

    // Task-8 ruling: a phone that is present but not a plausible Indian
    // mobile is kept on `flaggedPhoneRaw` rather than dropped. It is already
    // preserved in legacyRaw above; it also gets its own review item so it
    // surfaces on the migration queue rather than only inside a JSON blob.
    if (contactDetailsForRow?.flaggedPhoneRaw !== undefined) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "SUSPECT_PHONE",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "Phone",
        rawValue: contactDetailsForRow.flaggedPhoneRaw,
        detail: `"2025 YEAR" Phone column value is not a plausible Indian mobile number.`,
      });
    }
  }

  for (const proposedGroup of input.proposedGroups) {
    const firstCaseRefInGroup = proposedGroup.caseRefs[0];
    // ProposedGroup.caseRefs is never empty in practice (proposeGroups only
    // emits runs of >= 2), but the type does not say so -- skip rather than
    // record a review item with no caseRef to name.
    if (firstCaseRefInGroup === undefined) continue;

    const earliestRow = earliestMappedRowForCaseRefs(input.mappedRows, proposedGroup.caseRefs);
    await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
      reason: "PROPOSED_GROUP",
      sourceSheet: earliestRow?.sourceSheet ?? MINI_CRM_SHEET_NAME,
      sourceRow: earliestRow?.sourceRow ?? 1,
      caseRef: firstCaseRefInGroup,
      fieldName: "REF NO.",
      rawValue: proposedGroup.caseRefs.join(", "),
      detail: `Adjacent REF NOs ${proposedGroup.caseRefs.join(", ")} share partner "${proposedGroup.partnerName}", country ${proposedGroup.destinationCountry}, received ${proposedGroup.receivedDate}. Review for merge.`,
    });
  }

  return summary;
}
