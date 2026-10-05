import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT_ID,
  MEMORY_ORG_SCOPE,
  MEMORY_PARTNER_SCOPE_PREFIX,
  MEMORY_USER_SCOPE_PREFIX,
} from "../../src/domain/crm/keys";

describe("crm keys", () => {
  it("defaults to the rgs tenant", () => {
    expect(DEFAULT_TENANT_ID).toBe("rgs");
  });

  it("names memory scopes without a table partition", () => {
    expect(MEMORY_ORG_SCOPE).toBe("ORG");
    expect(MEMORY_PARTNER_SCOPE_PREFIX).toBe("PARTNER#");
    expect(MEMORY_USER_SCOPE_PREFIX).toBe("USER#");
  });

  const RETIRED_TABLE_KEY_PATTERN =
    /["'`](META|APPLICANT#|NOTE#|EVENT#|TENANT#|CRM_MEMORY#|GSI1|GSI2|GSI3)/g;

  function retiredTableKeyLiteralsIn(source: string): string[] {
    return source.match(RETIRED_TABLE_KEY_PATTERN) ?? [];
  }

  async function collectTsFilesRecursively(directoryUrl: URL): Promise<string[]> {
    const entries = await readdir(directoryUrl, { recursive: true });
    return entries.filter((entryName) => entryName.endsWith(".ts"));
  }

  it("does not resurrect single-table key literals in domain or agent source", async () => {
    const roots = [
      new URL("../../src/domain/", import.meta.url),
      new URL("../../src/agent/", import.meta.url),
    ];
    for (const directory of roots) {
      const fileNames = await collectTsFilesRecursively(directory);
      expect(fileNames.length).toBeGreaterThan(0);
      for (const fileName of fileNames) {
        const source = await readFile(new URL(fileName, directory), "utf8");
        const keyLiterals = retiredTableKeyLiteralsIn(source);
        expect({ fileName, keyLiterals }).toEqual({ fileName, keyLiterals: [] });
      }
    }
  });
});
