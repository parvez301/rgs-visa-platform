import { describe, expect, it } from "vitest";
import { databaseUrlFromEnvironment } from "../src/lib/sql";

describe("databaseUrlFromEnvironment", () => {
  it("returns undefined when DATABASE_URL is missing", () => {
    expect(databaseUrlFromEnvironment({})).toBeUndefined();
  });

  it("returns the trimmed URL when set", () => {
    expect(
      databaseUrlFromEnvironment({ DATABASE_URL: "  postgresql://user:pass@host:6543/postgres  " }),
    ).toBe("postgresql://user:pass@host:6543/postgres");
  });
});
