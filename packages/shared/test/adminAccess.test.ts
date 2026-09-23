import { describe, expect, it } from "vitest";
import {
  canAccessScreen,
  canWriteScreen,
  parseCognitoGroups,
  primaryRole,
  SCREEN_ACCESS,
} from "../src/adminAccess";

describe("parseCognitoGroups", () => {
  it.each([
    ['["Owner"]', ["Owner"]],
    ['["Owner","Ops"]', ["Owner", "Ops"]],
    // API Gateway HTTP API flattens a multi-valued claim to this form.
    ["[Owner]", ["Owner"]],
    ["[Owner Ops]", ["Owner", "Ops"]],
    ["[Owner, Ops]", ["Owner", "Ops"]],
    [["Finance", "Viewer"], ["Finance", "Viewer"]],
    [[], []],
    ["[]", []],
    ["", []],
  ])("normalizes %j", (claim, expected) => {
    expect(parseCognitoGroups(claim)).toEqual(expected);
  });

  it.each([undefined, null, "Owner", "not-json", '{"Owner":true}', [1, "Ops"], 42])(
    "returns empty for a missing or unrecognised claim: %j",
    (claim) => {
      expect(parseCognitoGroups(claim)).toEqual([]);
    },
  );

  it("resolves a primary role from the bracketed HTTP API form", () => {
    expect(primaryRole(parseCognitoGroups("[Owner Ops]"))).toBe("Owner");
  });
});

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
