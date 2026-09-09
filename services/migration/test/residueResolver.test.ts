import { describe, expect, it } from "vitest";
import { passthroughResidueResolver } from "../src/residueResolver";

describe("passthroughResidueResolver", () => {
  it("resolves nothing, so pass-1 residue flows to the human queue", async () => {
    const resolutions = await passthroughResidueResolver.resolve(
      { caseRef: "1" } as never,
      [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "???" }],
    );
    expect(resolutions).toEqual([]);
  });
});
