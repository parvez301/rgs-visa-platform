import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_NAME } from "../src/index";

describe("workspace sanity", () => {
  it("resolves the shared package entry point", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@rgs/shared");
  });
});
