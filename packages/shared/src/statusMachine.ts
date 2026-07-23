import type { ApplicationStatus } from "./statuses";

export const LEGAL_STATUS_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["DOCS_VERIFIED"],
  DOCS_VERIFIED: ["SENT_TO_IMMIGRATION"],
  SENT_TO_IMMIGRATION: ["APPROVED", "REJECTED"],
  APPROVED: ["DELIVERED"],
  REJECTED: [],
  DELIVERED: [],
};

export class IllegalStatusTransitionError extends Error {
  constructor(
    public readonly fromStatus: ApplicationStatus,
    public readonly toStatus: ApplicationStatus,
  ) {
    super(`Illegal application status transition: ${fromStatus} -> ${toStatus}`);
    this.name = "IllegalStatusTransitionError";
  }
}

export function canTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): boolean {
  return LEGAL_STATUS_TRANSITIONS[fromStatus].includes(toStatus);
}

export function assertTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): void {
  if (!canTransition(fromStatus, toStatus)) {
    throw new IllegalStatusTransitionError(fromStatus, toStatus);
  }
}
