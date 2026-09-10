import { ZodError } from "zod";
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { badRequest, forbidden } from "../../lib/errors";
import {
  collectReadableRecords,
  describeFirstZodIssue,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../../lib/storedRecords";
import { memoryPartitionKey } from "./keys";

/**
 * What the desk has taught the agent, at three scopes (spec "Memory"
 * section). The stored shape is `crm.CrmMemorySchema` (packages/shared,
 * carried since Plan 1, schemas.ts:153-170) -- this module is the first
 * reader and writer it has ever had (task-9-controller-notes.md §4).
 *
 * A memory's `scope` is one composite string on the stored record -- "ORG",
 * "PARTNER#<partnerId>" or "USER#<email>" -- never a (kind, key) pair, so a
 * caller cannot supply the two halves independently and have them disagree.
 * `MemoryScopeKind` below is only the CALLER-facing vocabulary for choosing
 * which kind of scope to build or query; `memoryScope` is the one place
 * that turns a kind (+ key, for PARTNER/USER) into the composite the table
 * actually partitions on, and `parseMemoryScope` is its inverse.
 */
export const MEMORY_SCOPE_KINDS = ["ORG", "PARTNER", "USER"] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

const ORG_SCOPE = "ORG";
const PARTNER_SCOPE_PREFIX = "PARTNER#";
const USER_SCOPE_PREFIX = "USER#";

export function memoryScope(kind: "ORG"): string;
export function memoryScope(kind: "PARTNER" | "USER", key: string): string;
export function memoryScope(kind: MemoryScopeKind, key?: string): string {
  if (kind === "ORG") return ORG_SCOPE;
  if (key === undefined || key.length === 0) {
    throw badRequest(kind === "PARTNER" ? "PARTNER scope needs a partnerId" : "USER scope needs an email");
  }
  return kind === "PARTNER" ? `${PARTNER_SCOPE_PREFIX}${key}` : `${USER_SCOPE_PREFIX}${key}`;
}

export interface ParsedMemoryScope {
  kind: MemoryScopeKind;
  key?: string;
}

/** The inverse of `memoryScope`. Throws badRequest on a string that is none of the three shapes. */
export function parseMemoryScope(scope: string): ParsedMemoryScope {
  if (scope === ORG_SCOPE) return { kind: "ORG" };
  if (scope.startsWith(PARTNER_SCOPE_PREFIX)) {
    return { kind: "PARTNER", key: scope.slice(PARTNER_SCOPE_PREFIX.length) };
  }
  if (scope.startsWith(USER_SCOPE_PREFIX)) {
    return { kind: "USER", key: scope.slice(USER_SCOPE_PREFIX.length) };
  }
  throw badRequest(`Unrecognized memory scope "${scope}"`);
}

/**
 * Refuses to let a USER-scope memory be written to, or deleted from, any
 * identity but the one performing the call right now.
 *
 * This is the domain layer's own copy of the rule `memoryTools.ts` already
 * enforces by construction -- USER scope is built from `actorEmail` there,
 * never from tool input, so a well-behaved caller can never even construct
 * a mismatched scope. It is kept here too because `rememberMemory` and
 * `forgetMemory` are the actual write path, and a future caller that reaches
 * them directly (a Task 11 admin endpoint, say) must not be able to skip the
 * check the tool happens to make redundant today -- the security property
 * this task exists for (task-9-controller-notes.md §2, and the brief's own
 * "security property" section: "a USER-scope memory is written under, and
 * deleted from, the acting user's identity only").
 */
function assertActorOwnsUserScope(scope: string, actorEmail: string): void {
  const parsedScope = parseMemoryScope(scope);
  if (parsedScope.kind === "USER" && parsedScope.key !== actorEmail) {
    throw forbidden("You may only write or delete your own USER-scope memories");
  }
}

export interface RememberMemoryInput {
  scope: string;
  memoryKey: string;
  text: string;
  sourceCaseId?: string;
}

/**
 * Idempotent by (scope, memoryKey): re-remembering the same key overwrites
 * the row in place rather than stacking a near-duplicate beside it --
 * memoryKey is caller-supplied and meaningful for exactly this reason
 * (task-9-controller-notes.md §4.1).
 */
export async function rememberMemory(
  context: AppContext,
  tenantId: string,
  input: RememberMemoryInput,
  actorEmail: string,
): Promise<crm.CrmMemory> {
  assertActorOwnsUserScope(input.scope, actorEmail);
  const memory = parseNewMemory({
    tenantId,
    scope: input.scope,
    memoryKey: input.memoryKey,
    text: input.text,
    ...(input.sourceCaseId !== undefined ? { sourceCaseId: input.sourceCaseId } : {}),
    // Only the agent write tool calls this today -- a human-authored memory
    // (the spec's editable Memory screen) is a future reader/writer of this
    // same schema, not this function.
    createdBy: "agent",
    createdAt: context.now().toISOString(),
    // router.ts defaults a missing `email` claim to "", and an empty string
    // is not an author -- omit the field rather than record a blank one,
    // exactly as createCase/createPartner do (cases.ts:85).
    ...(actorEmail !== "" ? { createdByEmail: actorEmail } : {}),
  });
  await writeMemory(context, tenantId, memory);
  return memory;
}

export async function forgetMemory(
  context: AppContext,
  tenantId: string,
  scope: string,
  memoryKey: string,
  actorEmail: string,
): Promise<void> {
  assertActorOwnsUserScope(scope, actorEmail);
  // Idempotent, like DynamoDB's own delete: forgetting a memoryKey nobody
  // ever remembered is not an error, it is simply a no-op.
  await context.table.delete(memoryPartitionKey(tenantId, scope), memoryKey);
}

export interface MemoryListing {
  memories: crm.CrmMemory[];
  /**
   * memoryKeys that exist in a requested scope but could not be read back.
   * Named rather than merely absent, so a memory vanishing from recall does
   * not look like a memory that was never taught -- the same rule
   * `reviewQueue.ts`/`partners.ts` follow for their own listings.
   */
  unreadableMemoryKeys: string[];
}

/**
 * One base-table query per requested scope -- no GSI, because the partition
 * key already IS the scope (task-9-controller-notes.md §4.1.3). Trusts the
 * scopes it is given exactly as `listReviewItems` trusts its reviewStatus
 * argument: resolving a USER scope to the right identity is the caller's
 * job -- the `recall` tool, which never takes it from tool input -- and this
 * function has no `actorEmail` to check one against.
 */
export async function recallMemories(
  context: AppContext,
  tenantId: string,
  scopes: string[],
): Promise<MemoryListing> {
  const memories: crm.CrmMemory[] = [];
  const unreadableMemoryKeys: string[] = [];
  for (const scope of scopes) {
    const storedItems = await context.table.query(memoryPartitionKey(tenantId, scope));
    const { records, unreadableRecordIds } = await collectReadableRecords(storedItems, parseStoredMemory, {
      entityDescription: "CRM memory",
      scopeDescription: `tenant ${tenantId} scope ${scope}`,
    });
    memories.push(...records);
    unreadableMemoryKeys.push(...unreadableRecordIds);
  }
  return { memories, unreadableMemoryKeys };
}

/**
 * Reads one memory row directly, for a write tool's `execute` to build an
 * honest "from" value in its diff -- undefined, not thrown, when nothing is
 * remembered yet under this key, which is the common case for a first
 * `remember`. A row that exists but will not parse still throws
 * (CorruptRecordError, uncaught here): silently treating a corrupt row as
 * "nothing remembered yet" would misdescribe the diff, not just skip it.
 */
export async function getMemoryOrUndefined(
  context: AppContext,
  tenantId: string,
  scope: string,
  memoryKey: string,
): Promise<crm.CrmMemory | undefined> {
  const storedItem = await context.table.get(memoryPartitionKey(tenantId, scope), memoryKey);
  return storedItem === undefined ? undefined : parseStoredMemory(storedItem);
}

async function writeMemory(context: AppContext, tenantId: string, memory: crm.CrmMemory): Promise<void> {
  await context.table.put({
    PK: memoryPartitionKey(tenantId, memory.scope),
    SK: memory.memoryKey,
    ...memory,
  });
}

/**
 * The write-path parse, and the only place a caller's input becomes a
 * CrmMemory. Raw, this was `crm.CrmMemorySchema.parse(...)` -- so a value
 * the refinement refuses (createdBy "agent" with no sourceCaseId, the exact
 * provenance guarantee this schema exists for -- task-9-controller-notes.md
 * §4) threw an untyped ZodError. router.ts maps only ApiError subclasses, so
 * this is a 400 naming the field instead, mirroring reviewQueue.ts's
 * `parseNewReviewItem`.
 */
function parseNewMemory(candidateMemory: Record<string, unknown>): crm.CrmMemory {
  try {
    return crm.CrmMemorySchema.parse(candidateMemory);
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(`CRM memory ${describeFirstZodIssue(error)}`);
    }
    throw error;
  }
}

/**
 * The single place a stored memory item becomes a domain CrmMemory. Typed as
 * CorruptRecordError (not a bare ZodError) so `recallMemories` can catch
 * precisely this and name the row instead of 500ing the whole recall.
 */
function parseStoredMemory(storedItem: TableItem): crm.CrmMemory {
  return parseStoredRecord(
    crm.CrmMemorySchema,
    "CRM memory",
    storedRecordId(storedItem, "memoryKey"),
    stripStorageKeys(storedItem),
  );
}
