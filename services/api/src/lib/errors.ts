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
