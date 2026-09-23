import { describe, expect, it } from "vitest";
import {
  canAccessScreen,
  canWriteScreen,
  primaryRole,
  SCREEN_ACCESS,
} from "../src/adminAccess";

describe("primaryRole", () => {
  it("prefers Owner when multiple groups are present", () => {
    expect(primaryRole(["Ops", "Owner"])).toBe("Owner");
  });
  it("returns null when no known role group is present", () => {
    expect(primaryRole([])).toBeNull();
    expect(primaryRole(["SomethingElse"])).toBeNull();
  });
});

describe("screen matrix", () => {
  it("gives Owner write on adminUsers and config", () => {
    expect(SCREEN_ACCESS.Owner.adminUsers).toBe("write");
    expect(SCREEN_ACCESS.Owner.config).toBe("write");
  });
  it("blocks Finance from queue and crmReview", () => {
    expect(canAccessScreen("Finance", "queue")).toBe(false);
    expect(canAccessScreen("Finance", "crmReview")).toBe(false);
    expect(canAccessScreen("Finance", "crm")).toBe(true);
    expect(canWriteScreen("Finance", "crm")).toBe(true);
  });
  it("makes Viewer read-only on crm and queue", () => {
    expect(canAccessScreen("Viewer", "crm")).toBe(true);
    expect(canWriteScreen("Viewer", "crm")).toBe(false);
    expect(canWriteScreen("Viewer", "queue")).toBe(false);
  });
  it("blocks Ops from config and adminUsers", () => {
    expect(canAccessScreen("Ops", "config")).toBe(false);
    expect(canAccessScreen("Ops", "adminUsers")).toBe(false);
  });
  it("treats null role as no access", () => {
    expect(canAccessScreen(null, "crm")).toBe(false);
    expect(canWriteScreen(null, "crm")).toBe(false);
  });
});
