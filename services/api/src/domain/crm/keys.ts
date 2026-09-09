/**
 * Every CRM key format lives here and nowhere else. Shapes come from spec §5.
 * A tenant segment is mandatory on every partition key: v1 serves one tenant,
 * but the keys are multi-tenant from day one so a second tenant needs no
 * migration.
 */

export const DEFAULT_TENANT_ID = "rgs";

export const CASE_META_SORT_KEY = "META";
export const APPLICANT_SORT_KEY_PREFIX = "APPLICANT#";
export const NOTE_SORT_KEY_PREFIX = "NOTE#";
export const EVENT_SORT_KEY_PREFIX = "EVENT#";

export function casePartitionKey(tenantId: string, caseId: string): string {
  return `TENANT#${tenantId}#CASE#${caseId}`;
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
