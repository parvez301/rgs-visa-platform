import { beforeEach, describe, expect, it, vi } from "vitest";

const poolState = vi.hoisted(() => ({
  clientCalls: [] as string[],
  poolQueryCalls: [] as string[],
  releases: [] as Array<unknown>,
  failOn: undefined as string | undefined,
  failRollback: false,
}));

vi.mock("pg", () => {
  class FakePool {
    async connect() {
      return {
        async query(text: string) {
          poolState.clientCalls.push(text);
          if (poolState.failOn !== undefined && text.includes(poolState.failOn)) {
            throw new Error("boom: " + poolState.failOn);
          }
          if (text === "ROLLBACK" && poolState.failRollback) throw new Error("connection lost");
          return { rows: [], rowCount: 0 };
        },
        release(destroy?: unknown) {
          poolState.releases.push(destroy);
        },
      };
    }
    async query(text: string) {
      poolState.poolQueryCalls.push(text);
      return { rows: [], rowCount: 0 };
    }
    async end() {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { createPgSqlClient } from "../src/lib/sql";

describe("createPgSqlClient().transaction", () => {
  beforeEach(() => {
    poolState.clientCalls.length = 0;
    poolState.poolQueryCalls.length = 0;
    poolState.releases.length = 0;
    poolState.failOn = undefined;
    poolState.failRollback = false;
  });

  it("runs BEGIN, every statement and COMMIT on one checked-out client, never the pool", async () => {
    const sql = createPgSqlClient("postgresql://example.invalid:6543/postgres");
    const value = await sql.transaction(async (tx) => {
      await tx.query("insert 1");
      await tx.query("insert 2");
      return "done";
    });
    expect(value).toBe("done");
    expect(poolState.clientCalls).toEqual(["BEGIN", "insert 1", "insert 2", "COMMIT"]);
    expect(poolState.poolQueryCalls).toEqual([]);
    expect(poolState.releases).toEqual([undefined]);
  });

  it("rolls back, releases the client and rethrows the callback's error", async () => {
    const sql = createPgSqlClient("postgresql://example.invalid:6543/postgres");
    poolState.failOn = "insert 2";
    await expect(
      sql.transaction(async (tx) => {
        await tx.query("insert 1");
        await tx.query("insert 2");
      }),
    ).rejects.toThrow("boom: insert 2");
    expect(poolState.clientCalls).toEqual(["BEGIN", "insert 1", "insert 2", "ROLLBACK"]);
    expect(poolState.releases).toEqual([undefined]);
  });

  it("keeps the original error when ROLLBACK itself fails, and destroys the connection", async () => {
    const sql = createPgSqlClient("postgresql://example.invalid:6543/postgres");
    poolState.failOn = "insert 1";
    poolState.failRollback = true;
    await expect(sql.transaction(async (tx) => tx.query("insert 1"))).rejects.toThrow("boom: insert 1");
    expect(poolState.releases).toEqual([true]);
  });
});
