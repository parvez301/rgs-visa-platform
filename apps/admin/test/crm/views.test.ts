import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerView } from "../../src/crm/ledger/views";
import { builtInLedgerViews, deleteView, loadViews, saveView } from "../../src/crm/ledger/views";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function buildView(overrides: Partial<LedgerView> = {}): LedgerView {
  return {
    viewId: "custom-1",
    name: "My saved view",
    filters: { statuses: ["NEW"] },
    sort: { column: "receivedDate", direction: "desc" },
    ...overrides,
  };
}

describe("builtInLedgerViews", () => {
  it("ships exactly the three named views, in order, and none deletable", () => {
    expect(builtInLedgerViews().map((view) => view.name)).toEqual(["Live work", "Awaiting payment", "Everything"]);
  });

  it("sorts 'Live work' by receivedDate desc and scopes it to LIVE_CASE_STATUSES", () => {
    const [liveWork] = builtInLedgerViews();
    expect(liveWork!.sort).toEqual({ column: "receivedDate", direction: "desc" });
    expect(liveWork!.filters.statuses.sort()).toEqual(
      ["NEW", "IN_PROGRESS", "APPOINTMENT_SET", "SUBMITTED"].sort(),
    );
  });

  it("'Awaiting payment' covers all statuses and filters to BILL_SENT/PART_PAID", () => {
    const awaitingPayment = builtInLedgerViews().find((view) => view.name === "Awaiting payment");
    expect(awaitingPayment?.filters.statuses).toHaveLength(9);
    expect(awaitingPayment?.filters.billingStatuses?.sort()).toEqual(["BILL_SENT", "PART_PAID"].sort());
  });

  it("'Everything' covers all nine statuses", () => {
    const everything = builtInLedgerViews().find((view) => view.name === "Everything");
    expect(everything?.filters.statuses).toHaveLength(9);
  });
});

describe("views", () => {
  it("round-trips a saved view", () => {
    const view = buildView({ viewId: "custom-round-trip", name: "My round trip" });

    saveView("ops@rgs.test", view);
    const loaded = loadViews("ops@rgs.test");

    expect(loaded.find((candidate) => candidate.viewId === "custom-round-trip")).toEqual(view);
  });

  it("keeps two users' views apart", () => {
    saveView("alice@rgs.test", buildView({ viewId: "custom-alice", name: "Alice's view" }));

    const bobsViews = loadViews("bob@rgs.test");

    expect(bobsViews.some((view) => view.viewId === "custom-alice")).toBe(false);
    expect(loadViews("alice@rgs.test").some((view) => view.viewId === "custom-alice")).toBe(true);
  });

  it("falls back to the built-in views when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });

    expect(loadViews("ops@rgs.test").map((view) => view.name)).toEqual([
      "Live work",
      "Awaiting payment",
      "Everything",
    ]);
  });

  it("falls back to the built-in views when the stored value is corrupt JSON", () => {
    localStorage.setItem("rgs.crm.views.ops@rgs.test", "{not valid json");

    expect(loadViews("ops@rgs.test").map((view) => view.name)).toEqual([
      "Live work",
      "Awaiting payment",
      "Everything",
    ]);
  });

  it("drops an implausible entry from a stored array rather than discarding every saved view", () => {
    localStorage.setItem(
      "rgs.crm.views.ops@rgs.test",
      JSON.stringify([{ viewId: "custom-good", name: "Good view", filters: { statuses: [] }, sort: {} }, 42, null]),
    );

    const loaded = loadViews("ops@rgs.test");

    expect(loaded.some((view) => view.viewId === "custom-good")).toBe(true);
    expect(loaded).toHaveLength(4); // 3 built-ins + the one plausible entry.
  });

  it("refuses to delete a built-in view", () => {
    const [liveWork] = builtInLedgerViews();

    deleteView("ops@rgs.test", liveWork!.viewId);

    expect(loadViews("ops@rgs.test").some((view) => view.viewId === liveWork!.viewId)).toBe(true);
  });

  it("deletes a saved (non-built-in) view", () => {
    saveView("ops@rgs.test", buildView({ viewId: "custom-deletable" }));

    deleteView("ops@rgs.test", "custom-deletable");

    expect(loadViews("ops@rgs.test").some((view) => view.viewId === "custom-deletable")).toBe(false);
  });

  it("refuses to save a custom view under a built-in view's id", () => {
    const [liveWork] = builtInLedgerViews();

    saveView("ops@rgs.test", buildView({ viewId: liveWork!.viewId, name: "Squatting on Live work" }));

    const loaded = loadViews("ops@rgs.test");
    const matchingViews = loaded.filter((view) => view.viewId === liveWork!.viewId);
    expect(matchingViews).toHaveLength(1);
    expect(matchingViews[0]!.name).toBe("Live work");
  });

  it("does not take the Ledger down when saving throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => saveView("ops@rgs.test", buildView())).not.toThrow();
  });
});
