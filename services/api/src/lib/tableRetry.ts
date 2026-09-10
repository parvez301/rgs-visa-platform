import type { TableClient, TableItem } from "./db";

/**
 * Retrying writes at the table-client seam (finding N11).
 *
 * The migration writes ~28,000 items in one process with no concurrency
 * control and no transaction. DynamoDB answers a burst past the table's
 * capacity with `ProvisionedThroughputExceededException` or
 * `ThrottlingException` — which, unhandled, aborts the whole import at
 * whichever row happened to be in flight. The reserve -> write -> complete
 * bracket means the next run repairs that, so nothing is corrupted; it just
 * means a 7,156-row import fails on a transient condition that a short sleep
 * would have absorbed.
 *
 * WRITES ONLY, deliberately. A `put` here is a full-item replace at a
 * deterministic key and a `delete` is idempotent by definition, so re-sending
 * either after a timeout cannot produce a second anything — which is what
 * makes a blind retry safe. Reads are left alone: a failed read aborts the
 * run without having changed the table, and retrying reads would be a
 * different change with a different argument behind it.
 *
 * Retryability is an ALLOWLIST, not a denylist. An error nobody anticipated
 * aborts on the first attempt rather than being re-sent five times: a
 * `ConditionalCheckFailedException` or a `ValidationException` will never
 * succeed on a retry, and hammering an unknown failure is how a small outage
 * becomes a large one.
 */
export interface WriteRetryOptions {
  /** Total attempts INCLUDING the first. 1 disables retrying entirely. */
  maxAttempts: number;
  /** Backoff before the second attempt; doubles from there. */
  initialDelayMs: number;
  /** Ceiling on one wait, so the exponential cannot run away. */
  maxDelayMs: number;
  /** Injected so tests do not actually sleep. */
  sleep: (delayMs: number) => Promise<void>;
  /** Injected so a test can pin the jitter. Returns [0, 1). */
  random: () => number;
  /** Called before each wait. `console.warn` in production. */
  onRetry: (attemptNumber: number, delayMs: number, error: unknown) => void;
}

/**
 * Five attempts spanning at most ~3.75s of backoff. Sized for a burst, not an
 * outage: an import that is being throttled for longer than that is being
 * throttled because the table's capacity is wrong, and the honest answer is
 * to abort and say so rather than to crawl for an hour.
 */
export const DEFAULT_WRITE_RETRY_OPTIONS: Readonly<
  Pick<WriteRetryOptions, "maxAttempts" | "initialDelayMs" | "maxDelayMs">
> = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
};

/**
 * Environment names for the cap, so it is configurable rather than hard-coded
 * at a call site. Cutover day is exactly when someone needs to raise it
 * without a code change and a redeploy.
 */
export const WRITE_RETRY_MAX_ATTEMPTS_VARIABLE = "RGS_WRITE_RETRY_MAX_ATTEMPTS";
export const WRITE_RETRY_INITIAL_DELAY_VARIABLE = "RGS_WRITE_RETRY_INITIAL_DELAY_MS";
export const WRITE_RETRY_MAX_DELAY_VARIABLE = "RGS_WRITE_RETRY_MAX_DELAY_MS";

function readPositiveInteger(
  environment: Record<string, string | undefined>,
  variableName: string,
  fallbackValue: number,
): number {
  const rawValue = environment[variableName];
  if (rawValue === undefined || rawValue.trim() === "") return fallbackValue;
  const parsedValue = Number(rawValue);
  // A typo must not silently disable retrying (Number("") is 0, Number("five")
  // is NaN), so anything unusable falls back to the default rather than
  // becoming a cap of zero.
  if (!Number.isInteger(parsedValue) || parsedValue < 1) return fallbackValue;
  return parsedValue;
}

export function writeRetryOptionsFromEnvironment(
  environment: Record<string, string | undefined>,
): Pick<WriteRetryOptions, "maxAttempts" | "initialDelayMs" | "maxDelayMs"> {
  return {
    maxAttempts: readPositiveInteger(
      environment,
      WRITE_RETRY_MAX_ATTEMPTS_VARIABLE,
      DEFAULT_WRITE_RETRY_OPTIONS.maxAttempts,
    ),
    initialDelayMs: readPositiveInteger(
      environment,
      WRITE_RETRY_INITIAL_DELAY_VARIABLE,
      DEFAULT_WRITE_RETRY_OPTIONS.initialDelayMs,
    ),
    maxDelayMs: readPositiveInteger(
      environment,
      WRITE_RETRY_MAX_DELAY_VARIABLE,
      DEFAULT_WRITE_RETRY_OPTIONS.maxDelayMs,
    ),
  };
}

/**
 * Throttling and genuinely transient failures. Names come from the DynamoDB
 * API and from Node's socket errors; the SDK also self-describes throttling
 * on `$retryable`, and any 5xx is the service saying "not you, me".
 */
const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "ThrottledException",
  "RequestLimitExceeded",
  "RequestThrottledException",
  "TooManyRequestsException",
  "InternalServerError",
  "InternalFailure",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
]);

const RETRYABLE_SOCKET_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

export function isRetryableWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errorFields = error as {
    name?: unknown;
    code?: unknown;
    $retryable?: { throttling?: unknown };
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof errorFields.name === "string" && RETRYABLE_ERROR_NAMES.has(errorFields.name)) {
    return true;
  }
  if (typeof errorFields.code === "string" && RETRYABLE_SOCKET_CODES.has(errorFields.code)) {
    return true;
  }
  if (errorFields.$retryable?.throttling === true) return true;
  const httpStatusCode = errorFields.$metadata?.httpStatusCode;
  if (typeof httpStatusCode === "number" && httpStatusCode >= 500) return true;
  return false;
}

/**
 * Full jitter: the wait is a uniform sample from [0, ceiling], not the
 * ceiling itself. Under a burst every writer that was throttled at the same
 * instant would otherwise wake at the same instant and throttle each other
 * again — the retry storm the backoff exists to prevent.
 */
export function writeRetryDelayMs(
  attemptNumber: number,
  options: Pick<WriteRetryOptions, "initialDelayMs" | "maxDelayMs">,
  randomFraction: number,
): number {
  const uncappedCeiling = options.initialDelayMs * 2 ** (attemptNumber - 1);
  const ceiling = Math.min(uncappedCeiling, options.maxDelayMs);
  return Math.round(randomFraction * ceiling);
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Wraps a table client so `put` and `delete` survive a burst of throttling.
 * Reads pass straight through.
 */
export function withWriteRetries(
  table: TableClient,
  overrides: Partial<WriteRetryOptions> = {},
): TableClient {
  const options: WriteRetryOptions = {
    ...DEFAULT_WRITE_RETRY_OPTIONS,
    sleep: defaultSleep,
    random: Math.random,
    onRetry: (attemptNumber, delayMs, error) => {
      const described = error instanceof Error ? error.name : String(error);
      console.warn(
        `Retrying a table write after ${described}: attempt ${attemptNumber} failed, waiting ${delayMs}ms.`,
      );
    },
    ...overrides,
  };

  async function withRetries<ResultType>(write: () => Promise<ResultType>): Promise<ResultType> {
    let attemptNumber = 1;
    for (;;) {
      try {
        return await write();
      } catch (error) {
        // The cap and the retryability test are both hard stops: the last
        // attempt's error is rethrown untouched, so the caller sees the real
        // cause rather than a wrapper that hides it.
        if (attemptNumber >= options.maxAttempts || !isRetryableWriteError(error)) throw error;
        const delayMs = writeRetryDelayMs(attemptNumber, options, options.random());
        options.onRetry(attemptNumber, delayMs, error);
        await options.sleep(delayMs);
        attemptNumber += 1;
      }
    }
  }

  return {
    get: (partitionKey, sortKey, getOptions) => table.get(partitionKey, sortKey, getOptions),
    query: (partitionKey, queryOptions) => table.query(partitionKey, queryOptions),
    queryGsi: (indexName, partitionKey, queryOptions) =>
      table.queryGsi(indexName, partitionKey, queryOptions),
    put: (item: TableItem) => withRetries(() => table.put(item)),
    delete: (partitionKey: string, sortKey: string) =>
      withRetries(() => table.delete(partitionKey, sortKey)),
  };
}
