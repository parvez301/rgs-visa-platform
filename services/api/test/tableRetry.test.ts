import { describe, expect, it, vi } from "vitest";
import { DynamoTableClient, InMemoryTableClient, type TableClient, type TableItem } from "../src/lib/db";
import {
  DEFAULT_WRITE_RETRY_OPTIONS,
  WRITE_RETRY_INITIAL_DELAY_VARIABLE,
  WRITE_RETRY_MAX_ATTEMPTS_VARIABLE,
  WRITE_RETRY_MAX_DELAY_VARIABLE,
  isRetryableWriteError,
  withWriteRetries,
  writeRetryDelayMs,
  writeRetryOptionsFromEnvironment,
} from "../src/lib/tableRetry";

/** What the DynamoDB SDK actually throws when a table is over capacity. */
function buildThrottlingError(): Error {
  const throttlingError = new Error("Throughput exceeds the current capacity of your table");
  throttlingError.name = "ProvisionedThroughputExceededException";
  return throttlingError;
}

/** A deterministic failure. Retrying it can only ever fail again. */
function buildValidationError(): Error {
  const validationError = new Error("One or more parameter values were invalid");
  validationError.name = "ValidationException";
  return validationError;
}

interface WriteAttemptLog {
  putAttempts: number;
  deleteAttempts: number;
  getAttempts: number;
}

/**
 * Fails the first `failureCount` writes with `error`, then behaves. Counts
 * every attempt, so a test can assert on how many were made rather than
 * inferring it from whether the call eventually succeeded.
 */
function tableFailingFirstWrites(
  table: TableClient,
  failureCount: number,
  error: Error,
  attemptLog: WriteAttemptLog,
): TableClient {
  return {
    get: (partitionKey, sortKey, options) => {
      attemptLog.getAttempts += 1;
      return table.get(partitionKey, sortKey, options);
    },
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    put: async (item: TableItem) => {
      attemptLog.putAttempts += 1;
      if (attemptLog.putAttempts <= failureCount) throw error;
      await table.put(item);
    },
    delete: async (partitionKey: string, sortKey: string) => {
      attemptLog.deleteAttempts += 1;
      if (attemptLog.deleteAttempts <= failureCount) throw error;
      await table.delete(partitionKey, sortKey);
    },
  };
}

function buildItem(sortKey = "META"): TableItem {
  return { PK: "TENANT#rgs#THING#1", SK: sortKey, value: "kept" };
}

describe("withWriteRetries", () => {
  it("completes a write that is throttled a few times and then succeeds", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const storage = new InMemoryTableClient();
    const sleptFor: number[] = [];
    const retryingTable = withWriteRetries(
      tableFailingFirstWrites(storage, 3, buildThrottlingError(), attemptLog),
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        // Injected, so the suite does not actually wait for the backoff.
        sleep: async (delayMs) => {
          sleptFor.push(delayMs);
        },
        random: () => 1,
        onRetry: () => undefined,
      },
    );

    await retryingTable.put(buildItem());

    expect(attemptLog.putAttempts).toBe(4);
    expect(await storage.get("TENANT#rgs#THING#1", "META")).toBeDefined();
    // Three waits for three failures, growing exponentially and capped.
    expect(sleptFor).toEqual([100, 200, 400]);
  });

  it("stops at the configured cap and rethrows the underlying error", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const throttlingError = buildThrottlingError();
    const retryingTable = withWriteRetries(
      // Never recovers.
      tableFailingFirstWrites(new InMemoryTableClient(), Number.MAX_SAFE_INTEGER, throttlingError, attemptLog),
      { maxAttempts: 3, sleep: async () => undefined, random: () => 0, onRetry: () => undefined },
    );

    // The cap is a hard stop, and the caller sees the REAL cause rather than a
    // wrapper -- an operator reading "ProvisionedThroughputExceededException"
    // knows to raise the table's capacity; "retries exhausted" tells them
    // nothing about what to do next.
    await expect(retryingTable.put(buildItem())).rejects.toBe(throttlingError);
    expect(attemptLog.putAttempts).toBe(3);
  });

  it("does not retry a deterministic error even once", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const validationError = buildValidationError();
    const retryingTable = withWriteRetries(
      tableFailingFirstWrites(new InMemoryTableClient(), Number.MAX_SAFE_INTEGER, validationError, attemptLog),
      { maxAttempts: 5, sleep: async () => undefined, random: () => 0, onRetry: () => undefined },
    );

    // A retry loop around a deterministic failure multiplies the same failure
    // and delays the abort by the whole backoff budget. Retryability is an
    // allowlist for exactly this reason.
    await expect(retryingTable.put(buildItem())).rejects.toBe(validationError);
    expect(attemptLog.putAttempts).toBe(1);
  });

  it("retries deletes on the same terms as puts", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const storage = new InMemoryTableClient();
    await storage.put(buildItem());
    const retryingTable = withWriteRetries(
      tableFailingFirstWrites(storage, 2, buildThrottlingError(), attemptLog),
      { maxAttempts: 5, sleep: async () => undefined, random: () => 0, onRetry: () => undefined },
    );

    await retryingTable.delete("TENANT#rgs#THING#1", "META");

    expect(attemptLog.deleteAttempts).toBe(3);
    expect(await storage.get("TENANT#rgs#THING#1", "META")).toBeUndefined();
  });

  it("does not retry reads", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const throttlingError = buildThrottlingError();
    const failingReads: TableClient = {
      ...new InMemoryTableClient(),
      get: async () => {
        attemptLog.getAttempts += 1;
        throw throttlingError;
      },
      query: async () => [],
      queryGsi: async () => [],
      put: async () => undefined,
      delete: async () => undefined,
    };
    const retryingTable = withWriteRetries(failingReads, {
      maxAttempts: 5,
      sleep: async () => undefined,
      random: () => 0,
      onRetry: () => undefined,
    });

    // Scope, stated as a test rather than only in a comment: a failed read
    // aborts the run without having changed the table, so retrying it is a
    // separate change with a separate argument behind it.
    await expect(retryingTable.get("TENANT#rgs#THING#1", "META")).rejects.toBe(throttlingError);
    expect(attemptLog.getAttempts).toBe(1);
  });

  it("reports what it is doing, so a slow import is explicable", async () => {
    const attemptLog: WriteAttemptLog = { putAttempts: 0, deleteAttempts: 0, getAttempts: 0 };
    const retryNotices: string[] = [];
    const retryingTable = withWriteRetries(
      tableFailingFirstWrites(new InMemoryTableClient(), 1, buildThrottlingError(), attemptLog),
      {
        maxAttempts: 5,
        sleep: async () => undefined,
        random: () => 0,
        onRetry: (attemptNumber, delayMs, error) =>
          retryNotices.push(
            `${error instanceof Error ? error.name : "?"} attempt ${attemptNumber} wait ${delayMs}`,
          ),
      },
    );

    await retryingTable.put(buildItem());

    expect(retryNotices).toEqual(["ProvisionedThroughputExceededException attempt 1 wait 0"]);
  });
});

describe("isRetryableWriteError", () => {
  it("accepts throttling, transient and 5xx failures", () => {
    for (const errorName of [
      "ProvisionedThroughputExceededException",
      "ThrottlingException",
      "RequestLimitExceeded",
      "InternalServerError",
      "ServiceUnavailable",
      "TimeoutError",
    ]) {
      const error = new Error("transient");
      error.name = errorName;
      expect({ errorName, retryable: isRetryableWriteError(error) }).toEqual({
        errorName,
        retryable: true,
      });
    }
    expect(isRetryableWriteError(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toBe(true);
    // The SDK's own self-description, and any server-side status.
    expect(isRetryableWriteError({ name: "Weird", $retryable: { throttling: true } })).toBe(true);
    expect(isRetryableWriteError({ name: "Weird", $metadata: { httpStatusCode: 503 } })).toBe(true);
  });

  it("refuses deterministic failures and anything it does not recognise", () => {
    for (const errorName of [
      "ValidationException",
      "ConditionalCheckFailedException",
      "ResourceNotFoundException",
      "AccessDeniedException",
    ]) {
      const error = new Error("deterministic");
      error.name = errorName;
      expect({ errorName, retryable: isRetryableWriteError(error) }).toEqual({
        errorName,
        retryable: false,
      });
    }
    expect(isRetryableWriteError({ name: "Weird", $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isRetryableWriteError(new Error("plain"))).toBe(false);
    expect(isRetryableWriteError(undefined)).toBe(false);
    expect(isRetryableWriteError("throttled")).toBe(false);
  });
});

describe("writeRetryDelayMs", () => {
  it("doubles per attempt and stops at the ceiling", () => {
    const options = { initialDelayMs: 250, maxDelayMs: 2_000 };
    expect([1, 2, 3, 4, 5, 6].map((attempt) => writeRetryDelayMs(attempt, options, 1))).toEqual([
      250, 500, 1_000, 2_000, 2_000, 2_000,
    ]);
  });

  it("samples the whole interval rather than always waiting the ceiling", () => {
    const options = { initialDelayMs: 250, maxDelayMs: 2_000 };
    // Full jitter. Without it, every writer throttled at the same instant
    // wakes at the same instant and throttles the table again -- the retry
    // storm the backoff exists to prevent.
    expect(writeRetryDelayMs(3, options, 0)).toBe(0);
    expect(writeRetryDelayMs(3, options, 0.5)).toBe(500);
    expect(writeRetryDelayMs(3, options, 1)).toBe(1_000);
  });
});

describe("buildProductionContext", () => {
  it("puts the retry seam in front of the real table client", async () => {
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    try {
      const { buildProductionContext } = await import("../src/http/handler");
      const productionContext = buildProductionContext();
      // The wiring belongs here and nowhere else: `services/migration/src/cli.ts`
      // builds its context from this same function, so the import and the API
      // share one seam and neither carries a retry decision at a call site. A
      // bare DynamoTableClient coming back would mean the migration writes are
      // unprotected however good the wrapper is.
      expect(productionContext.table).not.toBeInstanceOf(DynamoTableClient);
    } finally {
      process.env = savedEnvironment;
    }
  });

  it("actually reads its retry cap from the environment, not just from a wrapper that could be configured", async () => {
    // The gap one level deeper than the test above: that test proves the
    // table is WRAPPED, but a wrapper built with `{}` instead of
    // `writeRetryOptionsFromEnvironment(process.env)` is still "wrapped" --
    // it would just always retry the default 5 times, silently ignoring
    // RGS_WRITE_RETRY_MAX_ATTEMPTS. So this drives an actual retryable
    // failure through the real seam and counts the underlying attempts,
    // rather than only inspecting the object shape.
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    process.env[WRITE_RETRY_MAX_ATTEMPTS_VARIABLE] = "1";
    // The underlying DynamoTableClient.put always fails with a retryable
    // error, so the only thing standing between one attempt and the default
    // five is whether the environment's cap of 1 actually reached the seam.
    const underlyingPutSpy = vi
      .spyOn(DynamoTableClient.prototype, "put")
      .mockRejectedValue(buildThrottlingError());
    try {
      const { buildProductionContext } = await import("../src/http/handler");
      const productionContext = buildProductionContext();

      await expect(
        productionContext.table.put({ PK: "TENANT#rgs#CASE#1", SK: "META" }),
      ).rejects.toThrow(/Throughput exceeds/);

      // Wired correctly, RGS_WRITE_RETRY_MAX_ATTEMPTS=1 means one attempt and
      // no retry. Wired as `{}`, the default cap of 5 would retry four more
      // times against the same always-failing mock.
      expect(underlyingPutSpy).toHaveBeenCalledTimes(1);
    } finally {
      underlyingPutSpy.mockRestore();
      process.env = savedEnvironment;
    }
  }, 15_000);

  // task-11-controller-notes.md §3: llmProviderConfigFromEnvironment
  // (agent/providers/config.ts) THROWS when LLM_PROVIDER/LLM_MODEL/
  // LLM_API_KEY is missing -- built eagerly and uncaught here, every
  // non-agent route (and the migration CLI, which shares this exact
  // function) would die at cold start in any deployment that has not
  // configured the agent yet.
  it("still builds a working context with llm undefined when no LLM environment variables are set", async () => {
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    delete process.env["LLM_PROVIDER"];
    delete process.env["LLM_MODEL"];
    delete process.env["LLM_API_KEY"];
    try {
      const { buildProductionContext } = await import("../src/http/handler");
      const productionContext = buildProductionContext();

      expect(productionContext.llm).toBeUndefined();
      // The rest of the context must still be fully wired -- a deployment
      // with no LLM configuration is not a broken deployment.
      expect(productionContext.adminNotificationAddress).toBe("info@rgs.test");
    } finally {
      process.env = savedEnvironment;
    }
  });

  // Branch review M1: a misconfigured provider used to be silent and
  // indistinguishable from "the agent is not enabled here" -- both present to
  // the owner as every agent turn answering "This request has no LLM provider
  // configured", with nothing saying why.
  it("warns, naming the configuration error, when the LLM environment is present but wrong", async () => {
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    process.env["LLM_PROVIDER"] = "anthropik"; // the typo this exists for
    process.env["LLM_MODEL"] = "claude-test-model";
    process.env["LLM_API_KEY"] = "super-secret-key-value";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { buildProductionContext } = await import("../src/http/handler");
      const productionContext = buildProductionContext();

      // Still lazy: a bad LLM configuration must not take the whole API down
      // at cold start for every non-agent route (P27).
      expect(productionContext.llm).toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnedMessage = String(warnSpy.mock.calls[0]?.[0]);
      expect(warnedMessage).toContain("anthropik");
      // The whole reason this is safe to log at all -- the same guarantee
      // providers.test.ts's two leak tests pin at the source.
      expect(warnedMessage).not.toContain("super-secret-key-value");
    } finally {
      warnSpy.mockRestore();
      process.env = savedEnvironment;
    }
  });

  it("builds a real llm provider when the LLM environment variables are present", async () => {
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    process.env["LLM_PROVIDER"] = "anthropic";
    process.env["LLM_MODEL"] = "claude-test-model";
    process.env["LLM_API_KEY"] = "test-key";
    delete process.env["LLM_FALLBACK_PROVIDER"];
    delete process.env["LLM_THINKING"];
    try {
      const { buildProductionContext } = await import("../src/http/handler");
      const productionContext = buildProductionContext();

      expect(productionContext.llm).toBeDefined();
      expect(productionContext.llm?.name).toBe("anthropic");
    } finally {
      process.env = savedEnvironment;
    }
  });
});

describe("writeRetryOptionsFromEnvironment", () => {
  it("defaults when nothing is set", () => {
    expect(writeRetryOptionsFromEnvironment({})).toEqual(DEFAULT_WRITE_RETRY_OPTIONS);
  });

  it("takes the cap from the environment, so cutover day needs no redeploy", () => {
    expect(
      writeRetryOptionsFromEnvironment({
        [WRITE_RETRY_MAX_ATTEMPTS_VARIABLE]: "9",
        [WRITE_RETRY_INITIAL_DELAY_VARIABLE]: "10",
        [WRITE_RETRY_MAX_DELAY_VARIABLE]: "5000",
      }),
    ).toEqual({ maxAttempts: 9, initialDelayMs: 10, maxDelayMs: 5_000 });
  });

  it("falls back rather than letting a typo disable retrying", () => {
    // Number("") is 0 and Number("five") is NaN; either read literally would
    // mean "zero attempts", i.e. an import that aborts on the first throttle
    // because someone fat-fingered an environment variable.
    for (const unusableValue of ["", "   ", "five", "0", "-3", "2.5"]) {
      expect(
        writeRetryOptionsFromEnvironment({ [WRITE_RETRY_MAX_ATTEMPTS_VARIABLE]: unusableValue })
          .maxAttempts,
      ).toBe(DEFAULT_WRITE_RETRY_OPTIONS.maxAttempts);
    }
  });
});
