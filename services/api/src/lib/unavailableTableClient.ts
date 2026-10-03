import type { TableClient } from "./db";

const UNAVAILABLE_ERROR = new Error(
  "DynamoDB is not configured (TABLE_NAME unset)",
);

function rejectUnavailable(): Promise<never> {
  return Promise.reject(UNAVAILABLE_ERROR);
}

export function unavailableTableClient(): TableClient {
  return {
    get: () => rejectUnavailable(),
    put: () => rejectUnavailable(),
    putIfAbsent: () => rejectUnavailable(),
    delete: () => rejectUnavailable(),
    query: () => rejectUnavailable(),
    queryGsi: () => rejectUnavailable(),
    queryGsiPage: () => rejectUnavailable(),
  };
}
