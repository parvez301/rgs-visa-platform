import type { TableClient } from "./db";

function rejectUnavailable(): Promise<never> {
  return Promise.reject(
    new Error("DynamoDB is not configured (TABLE_NAME unset)"),
  );
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
