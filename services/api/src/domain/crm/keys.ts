/**
 * Every CRM key format lives here and nowhere else. Shapes come from spec §5.
 * A tenant segment is mandatory on every partition key: v1 serves one tenant,
 * but the keys are multi-tenant from day one so a second tenant needs no
 * migration.
 */

export const DEFAULT_TENANT_ID = "rgs";

/**
 * The sort key every "the record itself" item uses — cases, partners and
 * travellers alike. One constant, because it is one storage decision.
 */
export const META_SORT_KEY = "META";
export const APPLICANT_SORT_KEY_PREFIX = "APPLICANT#";
export const NOTE_SORT_KEY_PREFIX = "NOTE#";
export const EVENT_SORT_KEY_PREFIX = "EVENT#";

const CASE_PARTITION_KEY_INFIX = "#CASE#";

export function casePartitionKey(tenantId: string, caseId: string): string {
  return `TENANT#${tenantId}${CASE_PARTITION_KEY_INFIX}${caseId}`;
}

/**
 * Recovers the caseId a case partition key was built from, or undefined if the
 * key is not one. The inverse lives here because keys.ts is the only file that
 * knows the format; callers need it when a stored META item has lost the
 * caseId from its own body and the key is the last thing that still names it.
 */
export function caseIdFromPartitionKey(partitionKey: string): string | undefined {
  const infixIndex = partitionKey.indexOf(CASE_PARTITION_KEY_INFIX);
  if (infixIndex === -1) return undefined;
  const caseId = partitionKey.slice(infixIndex + CASE_PARTITION_KEY_INFIX.length);
  return caseId.length > 0 ? caseId : undefined;
}

/**
 * The partition a caseRef's import reservation lives in.
 *
 * GSI1 (the case-status index) is the only way to ask "which caseRefs are
 * already imported", and a GSI cannot be read consistently — so an importer
 * re-run seconds after an aborted one does not see the cases that run wrote
 * and imports them again. A reservation is keyed on the ref itself, so it is
 * a base-table GetItem, which CAN be strongly consistent.
 */
export function caseRefIndexPartitionKey(tenantId: string, caseRef: string): string {
  return `TENANT#${tenantId}#CASE_REF#${caseRef}`;
}

export function partnerPartitionKey(tenantId: string, partnerId: string): string {
  return `TENANT#${tenantId}#PARTNER#${partnerId}`;
}

export function travellerPartitionKey(tenantId: string, travellerId: string): string {
  return `TENANT#${tenantId}#TRAVELLER#${travellerId}`;
}

/**
 * Zero-padded so lexicographic sort order matches applicant order — the case
 * reassembly in caseStore relies on this.
 */
export function applicantSortKey(applicantIndex: number): string {
  return `${APPLICANT_SORT_KEY_PREFIX}${String(applicantIndex).padStart(2, "0")}`;
}

export function partnerListGsi1Pk(tenantId: string): string {
  return `TENANT#${tenantId}#PARTNERS`;
}

export function caseStatusGsi1Pk(tenantId: string, caseStatus: string): string {
  return `TENANT#${tenantId}#CASE_STATUS#${caseStatus}`;
}

export function partnerCasesGsi2Pk(tenantId: string, partnerId: string): string {
  return `TENANT#${tenantId}#PARTNER#${partnerId}`;
}

export function passportGsi3Pk(tenantId: string, passportNumber: string): string {
  return `TENANT#${tenantId}#PASSPORT#${passportNumber}`;
}

export function travellerNameGsi2Pk(tenantId: string, normalizedName: string): string {
  return `TENANT#${tenantId}#TRAVELLER_NAME#${normalizedName}`;
}

export function eventSortKey(createdAt: string, eventId: string): string {
  return `${createdAt}#${eventId}`;
}

/**
 * The sort key for a review item's own "the record itself" item. Reuses
 * META_SORT_KEY rather than a second "META" literal, so review items share
 * the same storage decision as cases, partners and travellers.
 */
export const REVIEW_ITEM_SORT_KEY = META_SORT_KEY;

export function reviewItemPartitionKey(tenantId: string, reviewItemId: string): string {
  return `TENANT#${tenantId}#REVIEW#${reviewItemId}`;
}

export function reviewQueueGsi1Pk(tenantId: string, reviewStatus: string): string {
  return `TENANT#${tenantId}#REVIEW_STATUS#${reviewStatus}`;
}

/**
 * A tenant-wide reference record, not a case: one checklist per destination
 * country rather than per case, so every case bound for that country reads
 * the same list of required documents.
 */
export function countryChecklistPartitionKey(tenantId: string, countryCode: string): string {
  return `TENANT#${tenantId}#COUNTRY#${countryCode}`;
}

/**
 * The sort key for a proposed change's own "the record itself" item. Reuses
 * META_SORT_KEY rather than a second "META" literal, for the same reason
 * REVIEW_ITEM_SORT_KEY does: proposals share the same storage decision as
 * cases, partners, travellers and review items.
 */
export const PROPOSAL_SORT_KEY = META_SORT_KEY;

export function proposalPartitionKey(tenantId: string, proposalId: string): string {
  return `TENANT#${tenantId}#PROPOSAL#${proposalId}`;
}

export function proposalStatusGsi1Pk(tenantId: string, proposalStatus: string): string {
  return `TENANT#${tenantId}#PROPOSAL_STATUS#${proposalStatus}`;
}

/**
 * The partition every row of one memory scope lives in. One builder, not
 * two: recall needs no secondary index (task-9-controller-notes.md §4.1.3)
 * -- the partition key already IS the scope, so a single
 * `context.table.query(memoryPartitionKey(tenantId, scope))` per requested
 * scope reads exactly that scope's rows off the base table. `memoryKey`
 * (caller-supplied and meaningful, never a generated id) is the sort key,
 * used directly with no prefix, per spec §"Memory" / the design doc's key
 * layout (docs/superpowers/specs/2026-09-09-rgs-crm-design.md:460-462).
 */
export function memoryPartitionKey(tenantId: string, scope: string): string {
  return `TENANT#${tenantId}#CRM_MEMORY#${scope}`;
}

/**
 * The three shapes a memory `scope` string takes (fix round 1, Minor 4):
 * these are as much a piece of the key layout as `memoryPartitionKey` above
 * -- the scope half of `TENANT#<t>#CRM_MEMORY#<scope>` -- so they live here,
 * the one file allowed a CRM key literal, rather than in `memory.ts`.
 * `memory.ts`'s `memoryScope`/`parseMemoryScope` import these; they stay
 * domain logic and stay there -- this file owns the literals, not the
 * semantics of building or parsing a composite scope.
 */
export const MEMORY_ORG_SCOPE = "ORG";
export const MEMORY_PARTNER_SCOPE_PREFIX = "PARTNER#";
export const MEMORY_USER_SCOPE_PREFIX = "USER#";

/**
 * The sort key for a CRM user's own trust-ladder preferences row (task-10
 * brief: `TENANT#<t>#CRM_USER#<email>` / `PREFS`). A dedicated literal, not a
 * reuse of META_SORT_KEY: unlike a case, partner or traveller, a prefs row is
 * not "the record itself" for some other entity -- it is its own thing, one
 * per (tenant, user), and giving it a distinct sort key keeps that legible
 * rather than borrowing a name that means something else everywhere else it
 * appears.
 */
export const CRM_USER_PREFS_SORT_KEY = "PREFS";

/**
 * The partition one CRM user's trust-ladder preferences row lives in
 * (spec §7 / task-10-controller-notes.md §9). Keyed on email, not a minted
 * id: a user's prefs row is looked up by who they are, never listed, so
 * there is nothing for a generated id to do here.
 */
export function crmUserPrefsPartitionKey(tenantId: string, email: string): string {
  return `TENANT#${tenantId}#CRM_USER#${email}`;
}
