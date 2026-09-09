export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(entity: string): ApiError {
  return new ApiError(404, "NOT_FOUND", `${entity} not found`);
}

export function forbidden(message = "You do not have access to this resource"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "BAD_REQUEST", message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "CONFLICT", message);
}

/**
 * A stored record that cannot be reassembled into a valid domain object — a
 * half-written partition, not a bad request. Typed as its own class so a caller
 * that can carry on (a list view skipping one unreadable row) catches exactly
 * this and lets every other failure propagate.
 */
export class CorruptRecordError extends ApiError {
  constructor(
    entity: string,
    public readonly recordId: string,
    public readonly reason: string,
  ) {
    super(
      409,
      "CORRUPT_RECORD",
      `${entity} ${recordId} is stored in an unreadable state: ${reason}`,
    );
    this.name = "CorruptRecordError";
  }
}

export function corruptRecord(
  entity: string,
  recordId: string,
  reason: string,
): CorruptRecordError {
  return new CorruptRecordError(entity, recordId, reason);
}
