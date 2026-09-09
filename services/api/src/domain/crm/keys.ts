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
