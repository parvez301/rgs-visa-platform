import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "@rgs/api/src/lib/context";
import { CorruptRecordError, badRequest } from "@rgs/api/src/lib/errors";
import { newId } from "@rgs/api/src/lib/ids";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import {
  completeCaseRefReservation,
  readCaseRefReservation,
  reserveCaseRef,
  type CaseRefReservation,
} from "@rgs/api/src/domain/crm/caseRefIndex";
import { createPartner, findPartnerByName } from "@rgs/api/src/domain/crm/partners";
import {
  findTravellerByName,
  findTravellerByPassport,
  normalizeTravellerName,
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
  /**
   * Rows whose ref names a stored case the importer could not read. Skipped
   * rather than re-created — a second case under one ref is worse than a
   * missing one — and every one of them raises a review item.
   */
  casesSkippedUnreadable: number;
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
 * `ReviewItemSchema.sourceRow` is a positive int, so a review item about
 * something that is not a workbook row still needs one. Row 1 is the header
 * row, which never becomes a case, so it cannot collide with a real row's item.
 */
const HEADER_SOURCE_ROW = 1;

/**
 * `ReviewItemSchema.caseRef` is `min(1)`, and an unreadable stored case is
 * precisely the case whose ref nobody can read. Self-describing rather than
 * blank, and never a real ref.
 */
const UNREADABLE_CASE_REF_PLACEHOLDER = "(ref not readable)";

/**
 * `CrmCaseSchema.destinationCountry` and `.receivedDate` are both required,
 * but the workbook does not always supply them -- measured on the real file:
 * 452 of 7,156 rows leave `destinationCountry` empty (207 blank Country
 * cells, 245 present-but-unmapped) and 225 leave `receivedDate` unset (blank
 * or unparseable "C" cells). Unhandled, either would abort the run at
 * `CrmCaseSchema.parse` the same way the blank-partner defect would have --
 * it just was not named in the controller's ruling.
 *
 * Fix-round-1 ruling: this is NOT the "blank means not recorded" case (spec
 * §6) -- that rule covers an OPTIONAL field simply staying absent. These
 * fields are REQUIRED by the schema, so a value is fabricated, not omitted.
 * Fabrication is categorically different from absence and is never silent:
 * every substitution raises a `MISSING_REQUIRED_FIELD` review item carrying
 * the sentinel on `proposedValue`, so a human sees exactly which of the 452 /
 * 225 rows carry a placeholder instead of a real value. "1970-01-01" is the
 * most important of these to flag, since it is also `GSI2SK` -- an unflagged
 * placeholder date would sort 225 cases to the front of every partner
 * listing looking like the firm's oldest work. Sentinels are still chosen to
 * be self-describing where possible: "ZZ" is ISO-3166's reserved
 * user-assigned "unknown" code; "1970-01-01" predates RGS's operation
 * entirely, but only the review item makes that legible.
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
 * Fix-round-1 ruling: like the country/date sentinels above, this fabricates
 * a value for a required field, so it also raises a `MISSING_REQUIRED_FIELD`
 * review item -- fabrication is never silent, even though the placeholder
 * text is self-describing.
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
  /**
   * True for the one claimant that keeps the bare `caseRef`. Anything joined
   * on the raw ref -- phone, tracking number -- belongs to this row only.
   */
  isFirstClaimant: boolean;
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
 * Orders the rows claiming one `caseRef` by their own CONTENT, so the order
 * cannot move when the sheet does.
 *
 * The suffix used to come from `sourceRow`, which is a POSITION. The whole
 * premise of this plan is that the workbook is still being edited: insert one
 * row above `Mini CRM` 1302 and every later `sourceRow` shifts by one, so
 * `32669-R1302` becomes `32669-R1303`, the sweep recognises neither, and the
 * next run creates a second case for that row -- up to 18 of them per
 * insertion, compounding on every insertion after that.
 *
 * Traveller name, then passport, then partner. If all three tie the rows are
 * indistinguishable by content, so `sourceRow` breaks the tie: at that point
 * a shift between them cannot change which case is which, because nothing
 * else distinguishes them either.
 */
function compareDuplicateClaimants(leftRow: MappedRow, rightRow: MappedRow): number {
  const byTravellerName = leftRow.travellerFullName.localeCompare(rightRow.travellerFullName);
  if (byTravellerName !== 0) return byTravellerName;
  const byPassport = (leftRow.passportNumber ?? "").localeCompare(rightRow.passportNumber ?? "");
  if (byPassport !== 0) return byPassport;
  const byPartner = leftRow.partnerName.localeCompare(rightRow.partnerName);
  if (byPartner !== 0) return byPartner;
  return leftRow.sourceRow - rightRow.sourceRow;
}

/**
 * Ruling (task-9): `caseRef` is not unique -- 18 of 7,156 real refs are
 * duplicated, 14 spanning two different partners. One claimant keeps the bare
 * `caseRef`; every other imports under `${caseRef}-2`, `-3`, ... instead of
 * overwriting it. Both the first and every later row also carry the OTHER
 * rows' source rows, so the importer can raise one `DUPLICATE_REF` review
 * item per row.
 *
 * Which claimant keeps the bare ref is decided by `compareDuplicateClaimants`
 * -- by content, never by position. See its comment.
 *
 * Keyed by `sourceRow` rather than the `MappedRow` object itself: sourceRow
 * is the workbook's own unique row number, a plain, comparable, storable key.
 * That is a lookup key for this run only; it never reaches a stored ref.
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
    const rowsSortedByContent = [...rowsForRef].sort(compareDuplicateClaimants);
    for (const [claimantIndex, claimingRow] of rowsSortedByContent.entries()) {
      const otherSourceRows = rowsSortedByContent
        .filter((otherRow) => otherRow.sourceRow !== claimingRow.sourceRow)
        .map((otherRow) => otherRow.sourceRow);
      const effectiveCaseRef =
        claimantIndex === 0 ? claimingRow.caseRef : `${claimingRow.caseRef}-${claimantIndex + 1}`;
      resolutionBySourceRow.set(claimingRow.sourceRow, {
        effectiveCaseRef,
        otherSourceRows,
        isFirstClaimant: claimantIndex === 0,
      });
    }
  }
  return resolutionBySourceRow;
}

interface AlreadyImportedSweep {
  /** caseId by stored `caseRef`, for every case the status index can see. */
  caseIdByCaseRef: Map<string, string>;
  /** Stored cases whose META item names no readable `caseRef`. */
  unreadableCaseIds: string[];
}

/**
 * Ruling (task-9): idempotency is keyed on `caseRef` (here, the effective
 * ref after duplicate resolution). The per-ref reservation item is what
 * decides it (see `claimCaseRef`); this sweep exists for the two things a
 * per-ref read cannot answer — which stored cases are illegible, and which
 * of a proposed group's members were already imported before this run.
 * Sweeping only the default-limited first page of one status would
 * under-count on both.
 *
 * Two things this deliberately does NOT do any more.
 *
 * It does not reassemble the cases. It used to call `listCasesByStatus`,
 * which runs `readCase` per case: 2 strongly-consistent round-trips each,
 * 14,312 of them on the real workbook, to collect one attribute the index
 * query had already returned. `listCaseRefsByStatus` reads the ref off the
 * META item instead — 9 queries for the whole sweep.
 *
 * And it does not discard what it could not read. `listCasesByStatus`
 * returns `{ cases, unreadableCaseIds }`, and this function used to
 * destructure `cases` alone. A case that will not reassemble — META written,
 * applicant put lost to a timeout, which is exactly what a non-transactional
 * `writeCase` leaves behind — was therefore absent from BOTH lists the
 * importer saw, so its ref looked never-imported and was imported again,
 * under a fresh caseId, on that run and on every run after it. Nothing ever
 * reconciled the two cases sharing one ref.
 */
async function sweepAlreadyImportedCaseRefs(
  context: AppContext,
  tenantId: string,
): Promise<AlreadyImportedSweep> {
  const caseIdByCaseRef = new Map<string, string>();
  const unreadableCaseIds: string[] = [];
  for (const caseStatus of crm.CASE_STATUSES) {
    const caseRefListing = await listCaseRefsByStatus(
      context,
      tenantId,
      caseStatus,
      CASE_REF_SWEEP_PAGE_LIMIT,
    );
    for (const storedCaseRef of caseRefListing.storedCaseRefs) {
      caseIdByCaseRef.set(storedCaseRef.caseRef, storedCaseRef.caseId);
    }
    unreadableCaseIds.push(...caseRefListing.unreadableCaseIds);
  }
  return { caseIdByCaseRef, unreadableCaseIds };
}

/** What the importer is allowed to do with one row's effective `caseRef`. */
type CaseRefClaim =
  /** A case already holds this ref, in full. Nothing to do. */
  | { kind: "ALREADY_IMPORTED" }
  /**
   * This ref is spoken for by a stored case the importer cannot read. Skipped
   * and flagged: re-importing would put a second case under one ref, and the
   * unreadable one would stay invisible to every listing that exists.
   */
  | { kind: "UNREADABLE_STORED_CASE"; describedAs: string; reason: string }
  /** Free to import, under this caseId. */
  | {
      kind: "IMPORT";
      caseId: string;
      reservation: CaseRefReservation | undefined;
      /** True when a previous run reserved this ref and never wrote the case. */
      repairingReservation: boolean;
    };

/**
 * Decides, for one effective `caseRef`, whether a case may be written and
 * under which id.
 *
 * The ref's own reservation item is the authority, not the status sweep.
 * GSI1 is eventually consistent and cannot be read consistently, so "the
 * sweep did not see it" genuinely means "the sweep did not see it", not "it
 * is not there" — and an operator whose `--commit` aborted at row 5,000 and
 * who re-runs immediately is the ordinary case, with the last several hundred
 * writes exactly the ones the index has not caught up with. The reservation
 * is a base-table GetItem, so it is strongly consistent and never lies about
 * what a previous run did.
 *
 * A completed reservation ends it there: one read per row, and no reassembly
 * of the case at all. Every other answer is rare enough to afford a real
 * read of the case it names.
 */
async function claimCaseRef(
  context: AppContext,
  tenantId: string,
  effectiveCaseRef: string,
  caseIdByStoredCaseRef: ReadonlyMap<string, string>,
  dryRun: boolean,
): Promise<CaseRefClaim> {
  let existingReservation: CaseRefReservation | undefined;
  try {
    existingReservation = await readCaseRefReservation(context, tenantId, effectiveCaseRef);
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      // The reservation row itself will not parse, so it cannot be trusted to
      // say which case holds this ref -- and it cannot be ignored either,
      // because ignoring it is how a second case under one ref happens.
      return {
        kind: "UNREADABLE_STORED_CASE",
        describedAs: `the import reservation for REF ${effectiveCaseRef}`,
        reason: error.reason,
      };
    }
    throw error;
  }

  if (existingReservation?.completedAt !== undefined) {
    return { kind: "ALREADY_IMPORTED" };
  }

  if (existingReservation === undefined) {
    // No reservation. A case can still hold this ref: one imported before
    // reservations existed, or one whose reservation write was lost. The
    // sweep is allowed to answer here because a false negative from index lag
    // is impossible in this branch -- a fully imported case always leaves a
    // completed reservation, which was read consistently above.
    const sweptCaseId = caseIdByStoredCaseRef.get(effectiveCaseRef);
    if (sweptCaseId !== undefined) {
      return await claimAgainstStoredCase(context, tenantId, effectiveCaseRef, sweptCaseId);
    }
    const caseId = newId("case", context.now().getTime());
    return { kind: "IMPORT", caseId, reservation: undefined, repairingReservation: false };
  }

  // Reserved but never completed: a run died between the two writes. The
  // reserved id says exactly which partition to look at.
  const claimAgainstReservedCase = await claimAgainstStoredCase(
    context,
    tenantId,
    effectiveCaseRef,
    existingReservation.caseId,
  );
  if (claimAgainstReservedCase.kind === "IMPORT") {
    // Re-writing under the RESERVED caseId overwrites one partition, so it
    // repairs the gap with no possibility of a second case sharing the ref.
    return {
      kind: "IMPORT",
      caseId: existingReservation.caseId,
      reservation: existingReservation,
      repairingReservation: true,
    };
  }
  if (claimAgainstReservedCase.kind === "ALREADY_IMPORTED" && !dryRun) {
    // The case is there and readable; only the completion marker was lost.
    // Write it now so the next run needs no read at all.
    await completeCaseRefReservation(context, tenantId, existingReservation);
  }
  return claimAgainstReservedCase;
}

/**
 * Whether a stored case may be left alone, having actually read it. Only
 * reached for a ref whose reservation is missing or unfinished, never on the
 * ordinary already-imported path.
 */
async function claimAgainstStoredCase(
  context: AppContext,
  tenantId: string,
  effectiveCaseRef: string,
  caseId: string,
): Promise<CaseRefClaim> {
  try {
    const storedCase = await readCase(context, tenantId, caseId);
    if (storedCase !== undefined) {
      return { kind: "ALREADY_IMPORTED" };
    }
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      // The half-written case: META present, applicants lost to a timeout.
      // Skipped rather than re-created, and named so a human can repair it.
      return {
        kind: "UNREADABLE_STORED_CASE",
        describedAs: `case ${caseId} (REF ${effectiveCaseRef})`,
        reason: error.reason,
      };
    }
    throw error;
  }
  return { kind: "IMPORT", caseId, reservation: undefined, repairingReservation: false };
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
 *
 * Memoised per run on both lookup keys, the same way `resolvePartner` is, and
 * for two separate reasons.
 *
 * Correctness in production: `findTravellerByPassport` reads GSI3 and
 * `findTravellerByName` reads GSI2, and neither index can be read
 * consistently. Row n creates traveller "RAHUL SHARMA"; row n+1, milliseconds
 * later, queries GSI2 for the same normalized name, misses because
 * replication has not landed, and creates a SECOND record for one person --
 * splitting their case history and making the passport lookup return
 * whichever propagated first. The in-run map answers before the index is
 * asked, so the race has nowhere to happen.
 *
 * Honesty in the dry run: with nothing written, every lookup missed, so the
 * dry run reported `travellersCreated 7156 / travellersReused 0` against the
 * real `5534 / 1622` -- a 29% overstatement, in the one number the operator's
 * only pre-flight check exists to give them.
 *
 * The order below is exactly the uncached order (passport, then name), so
 * memoisation changes what is asked, never what is answered.
 */
async function resolveTraveller(
  context: AppContext,
  tenantId: string,
  fullName: string,
  passportNumber: string | undefined,
  phone: string | undefined,
  dryRun: boolean,
  travellerIdByLookupKey: Map<string, string>,
): Promise<TravellerResolution> {
  // Prefixed so a passport that happens to read like a normalized name
  // cannot collide with one.
  const passportLookupKey = passportNumber === undefined ? undefined : `passport#${passportNumber}`;
  const nameLookupKey = `name#${normalizeTravellerName(fullName)}`;

  if (passportLookupKey !== undefined) {
    const cachedByPassport = travellerIdByLookupKey.get(passportLookupKey);
    if (cachedByPassport !== undefined) {
      return { travellerId: cachedByPassport, created: false };
    }
    const existingByPassport = await findTravellerByPassport(context, tenantId, passportNumber!);
    if (existingByPassport !== undefined) {
      travellerIdByLookupKey.set(passportLookupKey, existingByPassport.travellerId);
      return { travellerId: existingByPassport.travellerId, created: false };
    }
  }

  const cachedByName = travellerIdByLookupKey.get(nameLookupKey);
  if (cachedByName !== undefined) {
    return { travellerId: cachedByName, created: false };
  }
  const existingByName = await findTravellerByName(context, tenantId, fullName);
  if (existingByName !== undefined) {
    travellerIdByLookupKey.set(nameLookupKey, existingByName.travellerId);
    return { travellerId: existingByName.travellerId, created: false };
  }

  const travellerId = dryRun
    ? newId("trv", context.now().getTime())
    : (
        await upsertTraveller(context, tenantId, {
          fullName,
          ...(passportNumber !== undefined ? { passportNumber } : {}),
          ...(phone !== undefined ? { phone } : {}),
        })
      ).travellerId;

  travellerIdByLookupKey.set(nameLookupKey, travellerId);
  if (passportLookupKey !== undefined) {
    travellerIdByLookupKey.set(passportLookupKey, travellerId);
  }
  return { travellerId, created: true };
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
  const alreadyImportedSweep = await sweepAlreadyImportedCaseRefs(context, tenantId);
  const alreadyImportedCaseRefs = alreadyImportedSweep.caseIdByCaseRef;
  const caseRefResolutionBySourceRow = resolveDuplicateCaseRefs(input.mappedRows);
  const partnerIdByCanonicalKey = new Map<string, string>();
  const travellerIdByLookupKey = new Map<string, string>();

  const summary: ImportSummary = {
    rowsRead: input.mappedRows.length,
    casesCreated: 0,
    casesSkippedAlreadyImported: 0,
    casesSkippedUnreadable: 0,
    partnersCreated: 0,
    partnersReused: 0,
    travellersCreated: 0,
    travellersReused: 0,
    reviewItemsRecorded: 0,
    groupsProposed: 0,
    createdCaseIds: [],
  };

  // A stored case whose ref cannot be read is reported before a single row is
  // processed: the importer cannot tell whether any of this run's refs are
  // already held by it, so the operator has to be able to see it exists.
  for (const unreadableCaseId of alreadyImportedSweep.unreadableCaseIds) {
    await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
      reason: "UNREADABLE_STORED_CASE",
      sourceSheet: MINI_CRM_SHEET_NAME,
      sourceRow: HEADER_SOURCE_ROW,
      caseRef: UNREADABLE_CASE_REF_PLACEHOLDER,
      fieldName: "REF NO.",
      rawValue: unreadableCaseId,
      detail: `Stored case ${unreadableCaseId} carries no readable REF NO., so this import cannot tell whether its ref is among the rows being imported. Repair or delete the stored record.`,
    });
  }

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

    const caseRefClaim = await claimCaseRef(
      context,
      tenantId,
      caseRefResolution.effectiveCaseRef,
      alreadyImportedCaseRefs,
      input.dryRun,
    );
    if (caseRefClaim.kind === "ALREADY_IMPORTED") {
      summary.casesSkippedAlreadyImported += 1;
      continue;
    }
    if (caseRefClaim.kind === "UNREADABLE_STORED_CASE") {
      summary.casesSkippedUnreadable += 1;
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "UNREADABLE_STORED_CASE",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "REF NO.",
        rawValue: caseRefResolution.effectiveCaseRef,
        detail: `REF ${caseRefResolution.effectiveCaseRef} is already held by ${caseRefClaim.describedAs}, which is stored in an unreadable state: ${caseRefClaim.reason}. This row was NOT imported -- a second case under one REF NO. would be worse than a missing one. Repair the stored record, then re-run the import.`,
      });
      continue;
    }
    if (caseRefClaim.repairingReservation) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "UNREADABLE_STORED_CASE",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "REF NO.",
        rawValue: caseRefResolution.effectiveCaseRef,
        detail: `A previous import reserved REF ${caseRefResolution.effectiveCaseRef} as case ${caseRefClaim.caseId} but never wrote the case -- it stopped between the two writes. This run re-wrote the case under that same id. Check the row against the workbook.`,
      });
    }

    // `joinPhones` keys its result by the RAW caseRef, so on a duplicated ref
    // every claimant matches the same record -- and the duplicate-ref ruling
    // protected the case while leaving the join hanging off it untouched.
    // Measured: 7 of the 18 duplicated refs carry a joined phone and/or
    // tracking number and 5 of those span two partners, so REF 32669 put
    // phone 9872668866 on a traveller at PARADISE TOURS *and* on a different
    // traveller at Ozzy Travels. `upsertTraveller` then stores that number on
    // a person it does not belong to: one agency's client's mobile, on a
    // rival agency's client's record, sourced from our own import.
    //
    // The ref names one case, so the contact record can only be attributed to
    // one claimant -- the one that keeps the bare ref. Every other claimant
    // gets nothing and a review item saying so.
    //
    // The row's OWN `trackingNumber` (Mini CRM c19) is not affected: it is
    // read off this row, not joined on the ref, so it is never ambiguous.
    const joinedContactDetails = input.contactDetails.get(mappedRow.caseRef);
    const contactDetailsForRow = caseRefResolution.isFirstClaimant ? joinedContactDetails : undefined;
    const contactDetailsWereWithheld =
      !caseRefResolution.isFirstClaimant && joinedContactDetails !== undefined;

    const travellerFullNameIsMissing = isBlankTravellerFullName(mappedRow.travellerFullName);
    const travellerFullNameForCase = travellerFullNameIsMissing
      ? unknownTravellerFullNameSentinel(mappedRow.sourceRow)
      : mappedRow.travellerFullName;
    const travellerResolution = await resolveTraveller(
      context,
      tenantId,
      travellerFullNameForCase,
      mappedRow.passportNumber,
      contactDetailsForRow?.phone,
      input.dryRun,
      travellerIdByLookupKey,
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

    const trackingNumberForApplicant =
      mappedRow.trackingNumber ?? contactDetailsForRow?.trackingNumber;

    const destinationCountryIsMissing = resolvedCaseDraft.destinationCountry === "";
    const destinationCountryForCase = destinationCountryIsMissing
      ? UNKNOWN_DESTINATION_COUNTRY_SENTINEL
      : resolvedCaseDraft.destinationCountry;
    const receivedDateIsMissing = resolvedCaseDraft.receivedDate === undefined;
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
        // The id the ref was reserved under, never a fresh one: re-writing a
        // reserved-but-unwritten case must overwrite its partition, not add a
        // second case under the same ref.
        caseId: caseRefClaim.caseId,
        caseRef: caseRefResolution.effectiveCaseRef,
        caseType: resolvedCaseDraft.caseType,
        partnerId: partnerResolution.partnerId,
        destinationCountry: destinationCountryForCase,
        ...(visaTypeForCase !== undefined ? { visaType: visaTypeForCase } : {}),
        ...(resolvedCaseDraft.entryType !== undefined ? { entryType: resolvedCaseDraft.entryType } : {}),
        ...(resolvedCaseDraft.processing !== undefined ? { processing: resolvedCaseDraft.processing } : {}),
        ...(resolvedCaseDraft.validity !== undefined ? { validity: resolvedCaseDraft.validity } : {}),
        caseStatus: resolvedCaseDraft.caseStatus,
        // Ruling/brief: a migrated row that says nothing about billing is
        // UNKNOWN, never UNBILLED -- the billing_overdue watchdog excludes
        // UNKNOWN, and UNBILLED would nag on thousands of imported cases.
        //
        // But "migrated rows carry no billing evidence", the reason this line
        // used to give, is not true of all of them: the sheet's own "payment
        // status" column states it outright on 32 rows (measured), and
        // mapRow maps only the spellings that are unambiguous. The other two
        // stay UNKNOWN and raise a review item rather than being guessed.
        billingStatus: resolvedCaseDraft.billingStatus ?? "UNKNOWN",
        receivedDate: receivedDateForCase,
        ...(resolvedCaseDraft.submissionDate !== undefined
          ? { submissionDate: resolvedCaseDraft.submissionDate }
          : {}),
        ...(resolvedCaseDraft.expectedCollectionDate !== undefined
          ? { expectedCollectionDate: resolvedCaseDraft.expectedCollectionDate }
          : {}),
        ...(resolvedCaseDraft.courierDate !== undefined
          ? { courierDate: resolvedCaseDraft.courierDate }
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
            // "Mini CRM" c19 first, the `2025 YEAR` join only as a fallback.
            // Sourcing it from the year sheet alone loses 31 tracking numbers
            // outright (measured): that sheet is a strict SUBSET of "Mini
            // CRM" by REF NO, so a ref it does not carry has no row to join
            // against, however good the join is.
            ...(trackingNumberForApplicant !== undefined
              ? { trackingNumber: trackingNumberForApplicant }
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
    //
    // Reserve -> write -> complete. `writeCase` is not transactional, so the
    // reservation brackets it: whatever this run dies in the middle of, the
    // next one can tell what happened and repair it under the same caseId
    // rather than creating a second case under the same ref.
    if (!input.dryRun) {
      const reservation =
        caseRefClaim.reservation ??
        (await reserveCaseRef(context, tenantId, caseRefResolution.effectiveCaseRef, migratedCase.caseId));
      await writeCase(context, migratedCase);
      await completeCaseRefReservation(context, tenantId, reservation);
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

    // The other half of the same defect: the phone and tracking number joined
    // on this ref could not be attributed to this row, so they were withheld
    // rather than copied onto a traveller they may not belong to.
    if (contactDetailsWereWithheld) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "DUPLICATE_REF",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "Phone",
        rawValue: joinedContactDetails?.phone ?? joinedContactDetails?.flaggedPhoneRaw ?? "",
        detail: `"2025 YEAR" holds contact details against REF NO. ${mappedRow.caseRef}, which source row(s) ${caseRefResolution.otherSourceRows.join(", ")} also claim. They were attached to the first claimant only and withheld here: attaching them to both would put one traveller's phone or tracking number on another traveller, at a different partner. Confirm who they belong to.`,
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

    // `2025 YEAR` duplicates 18 refs of its own, and a later row can carry a
    // different phone or tracking number for the same ref. The first value
    // wins (see `joinPhones`), and the ones that lost are named here rather
    // than being overwritten out of existence.
    if (contactDetailsForRow?.conflictingValues !== undefined) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "DUPLICATE_REF",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "Phone",
        rawValue: contactDetailsForRow.conflictingValues.join("; "),
        detail: `More than one "2025 YEAR" row carries REF NO. ${mappedRow.caseRef} with different contact details. The first was imported; these disagree with it and were not: ${contactDetailsForRow.conflictingValues.join("; ")}.`,
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

    // Fix-round-1 ruling: fabricating a value for a schema-required field is
    // never silent, even when spec §6 would treat the same blank as a
    // harmless absence on an OPTIONAL field. One MISSING_REQUIRED_FIELD
    // review item per fabrication, naming the workbook's own column header.
    if (destinationCountryIsMissing) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "MISSING_REQUIRED_FIELD",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "Country",
        rawValue: "",
        proposedValue: destinationCountryForCase,
        detail: `destinationCountry is required by the schema but the sheet did not record one; the placeholder "${destinationCountryForCase}" was written pending a real value.`,
      });
    }
    if (receivedDateIsMissing) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "MISSING_REQUIRED_FIELD",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "C",
        rawValue: "",
        proposedValue: receivedDateForCase,
        detail: `receivedDate is required by the schema but the sheet did not record one; the placeholder "${receivedDateForCase}" was written pending a real value. This placeholder is also the case's GSI2 sort key, so an unresolved row will sort to the front of partner listings.`,
      });
    }
    if (travellerFullNameIsMissing) {
      await recordReviewItemAndCount(context, tenantId, input.dryRun, summary, {
        reason: "MISSING_REQUIRED_FIELD",
        sourceSheet: mappedRow.sourceSheet,
        sourceRow: mappedRow.sourceRow,
        caseRef: mappedRow.caseRef,
        fieldName: "APPLICANTS NAME",
        rawValue: "",
        proposedValue: travellerFullNameForCase,
        detail: `The traveller's full name is required by the schema but the sheet did not record one; the placeholder "${travellerFullNameForCase}" was written pending a real name.`,
      });
    }
  }

  // Fix-round-1 ruling: the sheet is live, so a re-run is the expected case,
  // not the exception -- re-runnability is the entire reason idempotency was
  // required. Cases and partners are idempotent; recording a PROPOSED_GROUP
  // unconditionally on every call is not: a static re-run would re-queue the
  // same proposal every time (measured: 1,476 duplicates on a second real
  // full-workbook run). A group is only re-proposed when it has actually
  // changed -- i.e. when at least one of its member caseRefs was NOT already
  // imported as of this run's sweep. A no-change re-run then proposes
  // nothing; a run that adds a case adjacent to an existing group re-proposes
  // just that group, correctly. Checked against `alreadyImportedCaseRefs`
  // (already in hand from the sweep) rather than a per-item review-queue
  // read, which would be one more read per group on a path that already has
  // enough of them, and would not notice a group whose membership changed.
  for (const proposedGroup of input.proposedGroups) {
    const firstCaseRefInGroup = proposedGroup.caseRefs[0];
    // ProposedGroup.caseRefs is never empty in practice (proposeGroups only
    // emits runs of >= 2), but the type does not say so -- skip rather than
    // record a review item with no caseRef to name.
    if (firstCaseRefInGroup === undefined) continue;

    const hasNotYetImportedMember = proposedGroup.caseRefs.some(
      (memberCaseRef) => !alreadyImportedCaseRefs.has(memberCaseRef),
    );
    if (!hasNotYetImportedMember) continue;

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
    summary.groupsProposed += 1;
  }

  return summary;
}
