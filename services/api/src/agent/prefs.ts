import { ZodError } from "zod";
import { crm } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { badRequest } from "../lib/errors";
import {
  describeFirstZodIssue,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../lib/storedRecords";
import { CRM_USER_PREFS_SORT_KEY, crmUserPrefsPartitionKey } from "../domain/crm/keys";

/**
 * One CRM user's trust-ladder preferences (task-10 brief, spec §7). Persists
 * `crm.CrmUserPrefsSchema` -- carried in packages/shared since Plan 1 with no
 * reader or writer until now (task-10-controller-notes.md §9) -- rather than
 * a parallel shape invented for this task alone.
 *
 * WHAT IS AND IS NOT WIRED, as of the end of Plan 4 (branch review I4,
 * ruling P73). Read this before assuming the trust ladder is live:
 *
 * - `readUserPrefs` has one production caller: `loop.ts`, which reads the
 *   ladder on every turn.
 * - `recordConfirmedWithoutEdit` has one production caller: the approve
 *   route (`http/agentApi.ts`), which counts an approval a human made
 *   without changing a single field. That is the ADVANCEMENT SIGNAL, and
 *   nothing more -- it never touches `trustLevel` or `autoApplyOptIn`.
 * - `setUserPrefs` has NO production caller. Nothing in the product can move
 *   a user off `trustLevel: 0` / `autoApplyOptIn: false`. A trust-prefs route
 *   backed by it is a new product surface -- a screen where a human agrees to
 *   auto-apply, with everything that implies -- and it belongs to Plan 5, not
 *   to a fix round.
 * - `readTrustLevel` likewise has no caller: it was carried as MIN-7 with the
 *   note "Task 11 consumes it"; Task 11 read `readUserPrefs` directly.
 *
 * The consequence, stated plainly so the next reader does not have to grep
 * for it: the auto-apply half of `runAgentTurn` (loop.ts's trust ladder,
 * everything downstream of `eligibleForAutoApply`) is UNREACHABLE in
 * production today and is exercised only by tests. Safe by default -- every
 * write is staged for a human -- but it means the default-deny guard, the
 * `autoApplied` audit flag and P25's human-vs-machine distinction are all
 * currently proven by the suite rather than by production traffic.
 */

function defaultUserPrefs(tenantId: string, email: string): crm.CrmUserPrefs {
  // Every field spelled out, not `CrmUserPrefsSchema.parse({tenantId, email})`
  // relying on its `.default(...)`s: a user with no stored row is a new user
  // and this is the one place that decides what "new user" means, so it
  // should be legible without cross-referencing the schema.
  return {
    tenantId,
    email,
    trustLevel: 0,
    autoApplyOptIn: false,
    defaultFilters: {},
    confirmedWithoutEditCount: 0,
  };
}

async function readStoredUserPrefs(
  context: AppContext,
  tenantId: string,
  email: string,
): Promise<crm.CrmUserPrefs | undefined> {
  const storedItem = await context.table.get(crmUserPrefsPartitionKey(tenantId, email), CRM_USER_PREFS_SORT_KEY);
  if (storedItem === undefined) return undefined;
  return parseStoredRecord(
    crm.CrmUserPrefsSchema,
    "CRM user prefs",
    storedRecordId(storedItem, "email"),
    stripStorageKeys(storedItem),
  );
}

async function writeUserPrefs(
  context: AppContext,
  tenantId: string,
  userPrefs: crm.CrmUserPrefs,
): Promise<crm.CrmUserPrefs> {
  // A caller-supplied `trustLevel` outside {0,1,2}, or any other schema
  // violation, must never reach the table (fix-round-1 MIN-5 /
  // controller-notes §9): `prefs.ts` exists specifically to persist
  // `CrmUserPrefsSchema` rather than a parallel, unenforced shape. Caught
  // and rethrown as `badRequest`, not left as a raw `ZodError` -- router.ts
  // maps only `ApiError` subclasses, so an uncaught `ZodError` here would
  // answer 500 for what is, from a caller's point of view, an ordinary bad
  // request (the same reasoning `createCase`/`rememberMemory` already apply
  // to their own schema parses).
  let validatedUserPrefs: crm.CrmUserPrefs;
  try {
    validatedUserPrefs = crm.CrmUserPrefsSchema.parse(userPrefs);
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(`CRM user prefs ${describeFirstZodIssue(error)}`);
    }
    throw error;
  }
  await context.table.put({
    PK: crmUserPrefsPartitionKey(tenantId, validatedUserPrefs.email),
    SK: CRM_USER_PREFS_SORT_KEY,
    ...validatedUserPrefs,
  });
  return validatedUserPrefs;
}

/**
 * A user with no stored row yet, read back as the safest possible user
 * (task-10-controller-notes.md §6): level 0, opted out of auto-apply, no
 * confirmed-without-edit history.
 */
export async function readUserPrefs(
  context: AppContext,
  tenantId: string,
  email: string,
): Promise<crm.CrmUserPrefs> {
  const storedUserPrefs = await readStoredUserPrefs(context, tenantId, email);
  return storedUserPrefs ?? defaultUserPrefs(tenantId, email);
}

/**
 * Merges the given fields onto the user's current prefs (or the safe
 * defaults, for a first-time user) and persists the result. The one write
 * path every caller of this module goes through -- a future opt-in endpoint
 * (Task 11+) seeding `{ trustLevel: 2, autoApplyOptIn: true }` after a human
 * explicitly agrees, and this task's own tests seeding a trust level to
 * exercise the ladder, rather than either one writing a raw table row.
 */
export async function setUserPrefs(
  context: AppContext,
  tenantId: string,
  email: string,
  updates: Partial<Omit<crm.CrmUserPrefs, "tenantId" | "email">>,
): Promise<crm.CrmUserPrefs> {
  const currentUserPrefs = await readUserPrefs(context, tenantId, email);
  return writeUserPrefs(context, tenantId, { ...currentUserPrefs, ...updates });
}

/**
 * `0` for a user with no stored row: a user nobody has ever set a trust
 * level for is a new user, and a new user gets the safest behaviour --
 * every write staged, none auto-applied (task-10-controller-notes.md §6).
 */
export async function readTrustLevel(
  context: AppContext,
  tenantId: string,
  userEmail: string,
): Promise<0 | 1 | 2> {
  const userPrefs = await readUserPrefs(context, tenantId, userEmail);
  return userPrefs.trustLevel;
}

/**
 * Records that a human approved a staged proposal without changing a single
 * field of it -- one signal a future screen can use to PROPOSE moving this
 * user up the trust ladder. Never itself touches `trustLevel` or
 * `autoApplyOptIn`: advancement is opt-in and never silent
 * (task-10-controller-notes.md §6) -- counting confirmations is not the same
 * act as raising trust, and this function only ever does the former.
 */
export async function recordConfirmedWithoutEdit(
  context: AppContext,
  tenantId: string,
  userEmail: string,
): Promise<void> {
  const currentUserPrefs = await readUserPrefs(context, tenantId, userEmail);
  await writeUserPrefs(context, tenantId, {
    ...currentUserPrefs,
    confirmedWithoutEditCount: currentUserPrefs.confirmedWithoutEditCount + 1,
  });
}
