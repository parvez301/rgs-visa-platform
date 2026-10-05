/**
 * Tenant id and agent-memory scope strings. These are not storage keys —
 * CRM rows live in Postgres — but they still identify who a request belongs to.
 */

export const DEFAULT_TENANT_ID = "rgs";

export const MEMORY_ORG_SCOPE = "ORG";
export const MEMORY_PARTNER_SCOPE_PREFIX = "PARTNER#";
export const MEMORY_USER_SCOPE_PREFIX = "USER#";
