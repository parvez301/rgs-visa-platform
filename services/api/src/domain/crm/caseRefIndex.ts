import { ZodError, z } from "zod";
import type { AppContext } from "../../lib/context";
import { corruptRecord } from "../../lib/errors";
import { META_SORT_KEY, caseRefIndexPartitionKey } from "./keys";

/**
 * The importer's idempotency anchor: one tiny item per imported `caseRef`,
 * naming the `caseId` that ref was imported under and whether that import
 * ever finished.
 *
 * Why it exists. Idempotency used to be "sweep every case status through
 * GSI1 and collect the caseRefs". GSI1 is a global secondary index, and
 * DynamoDB refuses a consistent read on one — `runQuery` correctly passes
 * `ConsistentRead: undefined` for index queries. So an import that aborts
 * part-way and is re-run minutes later does not see the cases the first run
 * wrote: the index has not caught up, the sweep reports those refs as
 * never-imported, and the second run writes them all again under fresh
 * `caseId`s. Nothing reconciles that afterwards, because `caseRef` carries no
 * uniqueness constraint of its own.
 *
 * A reservation is keyed on the ref itself, so it lives in its own base-table
 * partition and is read with `ConsistentRead: true` — visible to the very
 * next reader, index lag or not.
 *
 * The two-step write is the point, not overhead. `writeCase` is not
 * transactional (3 sequential calls per case), so the reservation is written
 * BEFORE the case and marked complete AFTER it, which makes every way a run
 * can die distinguishable afterwards:
 *
 *  - no reservation                  -> this ref was never imported.
 *  - reservation, not complete       -> a run died between the two. The case
 *                                       is missing or half-written; the
 *                                       reserved `caseId` says exactly which
 *                                       partition to look at, and re-writing
 *                                       under THAT id repairs it instead of
 *                                       adding a second case under one ref.
 *  - reservation, complete           -> a case was fully written. Skip it,
 *                                       with no read of the case at all.
 *
 * Written the other way round (case first, reservation second) the first two
 * states are indistinguishable, and that ambiguity is what produces duplicate
 * refs.
 */
export interface CaseRefReservation {
  tenantId: string;
  caseRef: string;
  /** The caseId this ref was, or is being, imported under. */
  caseId: string;
  reservedAt: string;
  /** Set once the case itself has been written in full. */
  completedAt?: string;
}

const CaseRefReservationSchema = z.object({
  tenantId: z.string().min(1),
  caseRef: z.string().min(1),
  caseId: z.string().min(1),
  reservedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

/**
 * Strongly consistent by construction — an eventually consistent read here
 * would reintroduce the exact index lag this item exists to route around.
 */
export async function readCaseRefReservation(
  context: AppContext,
  tenantId: string,
  caseRef: string,
): Promise<CaseRefReservation | undefined> {
  const storedItem = await context.table.get(
    caseRefIndexPartitionKey(tenantId, caseRef),
    META_SORT_KEY,
    { consistentRead: true },
  );
  if (!storedItem) return undefined;
  try {
    return CaseRefReservationSchema.parse(stripStorageKeys(storedItem));
  } catch (error) {
    if (error instanceof ZodError) {
      // Raw, a ZodError is not an ApiError and router.ts maps only ApiError
      // subclasses, so it would leave here as a 500. Typed, a caller can
      // decide what to do with a reservation row it cannot read.
      throw corruptRecord("Case ref reservation", caseRef, describeFirstIssue(error));
    }
    throw error;
  }
}

/** Claims a ref for a caseId. Call before writing the case. */
export async function reserveCaseRef(
  context: AppContext,
  tenantId: string,
  caseRef: string,
  caseId: string,
): Promise<CaseRefReservation> {
  const reservation: CaseRefReservation = {
    tenantId,
    caseRef,
    caseId,
    reservedAt: context.now().toISOString(),
  };
  await writeReservation(context, reservation);
  return reservation;
}

/** Records that the reserved case is now fully written. Call after writing it. */
export async function completeCaseRefReservation(
  context: AppContext,
  tenantId: string,
  reservation: CaseRefReservation,
): Promise<CaseRefReservation> {
  const completedReservation: CaseRefReservation = {
    ...reservation,
    completedAt: context.now().toISOString(),
  };
  await writeReservation(context, completedReservation);
  return completedReservation;
}

async function writeReservation(
  context: AppContext,
  reservation: CaseRefReservation,
): Promise<void> {
  await context.table.put({
    PK: caseRefIndexPartitionKey(reservation.tenantId, reservation.caseRef),
    SK: META_SORT_KEY,
    ...reservation,
  });
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
}

function stripStorageKeys(storedItem: Record<string, unknown>): Record<string, unknown> {
  const { PK: _partitionKey, SK: _sortKey, ...domainFields } = storedItem;
  return domainFields;
}
