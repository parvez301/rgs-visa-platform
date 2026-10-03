import type { AppContext } from "../../lib/context";
import { readCaseRefReservationPostgres, writeCaseRefReservationPostgres } from "./caseRefIndexPostgres";
import { requireSql } from "./postgresClient";

/**
 * The importer's idempotency anchor: one tiny item per imported `caseRef`,
 * naming the `caseId` that ref was imported under and whether that import
 * ever finished.
 *
 * A reservation is keyed on the ref itself and read back strongly, so a
 * re-run importer sees exactly what the aborted run left behind.
 *
 * The two-step write is the point, not overhead. The reservation is written
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

export async function readCaseRefReservation(
  context: AppContext,
  tenantId: string,
  caseRef: string,
): Promise<CaseRefReservation | undefined> {
  return readCaseRefReservationPostgres(requireSql(context), tenantId, caseRef);
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
  await writeCaseRefReservationPostgres(requireSql(context), reservation);
}
