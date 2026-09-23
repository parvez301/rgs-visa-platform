import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { useReviewSummary } from "../../src/crm/api/hooks";
import { ReviewMarker } from "../../src/crm/ledger/ReviewMarker";

describe("ReviewMarker", () => {
  it("marks a case with field-level problems", () => {
    // `isFocusedRow={false}` on purpose (R74): a marked row carries its mark
    // whether or not the grid's focus is on it -- what roves with the focus is
    // only whether Tab can REACH the chip, which LedgerTable.test.tsx asserts
    // against a real grid.
    render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", openReasons: [], fieldItemIds: ["rev_1", "rev_2"], mergeItemIds: [] }} isFocusedRow={false} />);
    expect(screen.getByRole("button", { name: /2 import problems/i })).toBeInTheDocument();
  });

  it("marks a merge candidate differently from a field problem", () => {
    const { container: fieldMarker } = render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", openReasons: [], fieldItemIds: ["rev_1"], mergeItemIds: [] }} isFocusedRow={false} />);
    const { container: mergeMarker } = render(<ReviewMarker caseRef="RGS-1002" entry={{ caseRef: "RGS-1002", openReasons: [], fieldItemIds: [], mergeItemIds: ["rev_9"] }} isFocusedRow={false} />);

    expect(mergeMarker.textContent).toMatch(/may be a duplicate/i);
    expect(mergeMarker.firstElementChild?.className).not.toBe(fieldMarker.firstElementChild?.className);
  });

  it("renders no marker at all for a clean case", () => {
    const { container } = render(<ReviewMarker caseRef="RGS-1001" entry={undefined} isFocusedRow={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the items inline, fetching each one only when opened", async () => {
    // 3,958 `getReviewItem` calls on page load is the thing the summary route
    // exists to avoid, so "not on render" is as load-bearing as "on open".
    const requestLog = stubReviewFetch({
      fieldItemIds: ["rev_1", "rev_2"],
      reviewItemsById: {
        rev_1: buildReviewItem({ reviewItemId: "rev_1" }),
        rev_2: buildReviewItem({ reviewItemId: "rev_2", reason: "UNPARSEABLE_DATE", fieldName: "Received" }),
      },
    });
    renderMarkerForCase();

    const marker = await screen.findByRole("button", { name: /2 import problems/i });
    // Asserted after the summary has loaded and the marker has rendered, not
    // before: a marker that has not appeared yet trivially fetches nothing.
    expect(itemFetchesIn(requestLog)).toEqual([]);

    await userEvent.click(marker);

    await screen.findByText("Status not recognised");
    expect(await screen.findByText("Date could not be read")).toBeInTheDocument();
    // Exactly the ids the entry lists -- no walk of the queue, no neighbours.
    expect(itemFetchesIn(requestLog).sort()).toEqual(["rev_1", "rev_2"]);
  });

  it("resolves an item in place and drops it from the marker", async () => {
    const requestLog = stubReviewFetch({
      fieldItemIds: ["rev_1", "rev_2"],
      reviewItemsById: {
        rev_1: buildReviewItem({ reviewItemId: "rev_1" }),
        rev_2: buildReviewItem({ reviewItemId: "rev_2", reason: "UNPARSEABLE_DATE", fieldName: "Received" }),
      },
    });
    renderMarkerForCase();

    await userEvent.click(await screen.findByRole("button", { name: /2 import problems/i }));
    const firstItem = (await screen.findByText("Status not recognised")).closest("li")!;

    await userEvent.click(within(firstItem).getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(
        requestLog.some(
          (entry) => entry.method === "PUT" && entry.url.endsWith("/review/rev_1/resolve"),
        ),
      ).toBe(true),
    );
    // The count is the SUMMARY's id count (R69), so this only falls if the
    // resolve invalidated the summary and the refetch landed -- which is the
    // whole mechanism, and the reason the count is not tracked locally.
    expect(await screen.findByRole("button", { name: /1 import problem/i })).toBeInTheDocument();
    expect(screen.queryByText("Status not recognised")).not.toBeInTheDocument();
    expect(screen.getByText("Date could not be read")).toBeInTheDocument();
  });

  it("says plainly that recording a value does not change the case", async () => {
    stubReviewFetch({
      fieldItemIds: ["rev_1"],
      reviewItemsById: { rev_1: buildReviewItem({ reviewItemId: "rev_1", reason: "UNMAPPED_STATUS" }) },
    });
    renderMarkerForCase();

    await userEvent.click(await screen.findByRole("button", { name: /1 import problem/i }));
    await screen.findByText("Status not recognised");

    // `resolveReviewItem` closes the review item and writes nothing to the
    // case (reviewQueue.ts has no case write in it, by design). Copy that
    // implied otherwise would be a promise the backend does not keep.
    expect(screen.getByText(/records the decision.*does not change the case/i)).toBeInTheDocument();
  });

  it("reports a failed resolution rather than closing the item on screen", async () => {
    // Two reviewers working the same queue is the expected case, and
    // `reviewQueue.ts` refuses the second resolution rather than overwriting
    // the first reviewer's decision.
    const conflictMessage = "Review item rev_1 is already DISMISSED and cannot be resolved again";
    stubReviewFetch({
      fieldItemIds: ["rev_1"],
      reviewItemsById: { rev_1: buildReviewItem({ reviewItemId: "rev_1" }) },
      resolveFailuresByReviewItemId: { rev_1: { status: 409, message: conflictMessage } },
    });
    renderMarkerForCase();

    await userEvent.click(await screen.findByRole("button", { name: /1 import problem/i }));
    const firstItem = (await screen.findByText("Status not recognised")).closest("li")!;

    await userEvent.click(within(firstItem).getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(conflictMessage);
    // Still there, still resolvable: a row that vanished on a failure would
    // tell this reviewer their own decision had been recorded.
    expect(screen.getByText("Status not recognised")).toBeInTheDocument();
    expect(within(firstItem).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 import problem/i })).toBeInTheDocument();
  });

  it("opens the panel ABOVE a chip with no room below it, instead of below the fold", async () => {
    // Not an edge case: the Ledger is a full-height grid of 32px rows, so on
    // an 800px viewport roughly the bottom 40% of the chips a desk agent can
    // see have less than a panel's height beneath them. Anchored below with no
    // flip, every one of those panels opens off-screen -- and the panel is
    // `position: fixed`, so scrolling the grid never brings it back.
    stubReviewFetch({
      fieldItemIds: ["rev_1"],
      reviewItemsById: { rev_1: buildReviewItem({ reviewItemId: "rev_1" }) },
    });
    setViewportSize({ innerWidth: 1280, innerHeight: 800 });
    renderMarkerForCase();

    const marker = await screen.findByRole("button", { name: /1 import problem/i });
    const chipTopPx = 700;
    stubChipRect(marker, { top: chipTopPx, left: 40 });

    await userEvent.click(marker);

    const panel = screen.getByRole("group", { name: `Import review for ${TEST_CASE_REF}` });
    // The whole panel, not just its top edge, has to end up above the chip.
    expect(parseFloat(panel.style.top) + PANEL_MAX_HEIGHT_PX).toBeLessThanOrEqual(chipTopPx);
  });

  it("clamps the panel inside the viewport's right edge", async () => {
    stubReviewFetch({
      fieldItemIds: ["rev_1"],
      reviewItemsById: { rev_1: buildReviewItem({ reviewItemId: "rev_1" }) },
    });
    const viewportWidthPx = 1000;
    setViewportSize({ innerWidth: viewportWidthPx, innerHeight: 800 });
    renderMarkerForCase();

    const marker = await screen.findByRole("button", { name: /1 import problem/i });
    stubChipRect(marker, { top: 100, left: 900 });

    await userEvent.click(marker);

    const panel = screen.getByRole("group", { name: `Import review for ${TEST_CASE_REF}` });
    expect(parseFloat(panel.style.left)).toBe(viewportWidthPx - PANEL_WIDTH_PX);
  });
});

const TEST_CASE_REF = "RGS-1001";

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  roles: ["Ops"],
  primaryRole: "Ops",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

interface RequestLogEntry {
  method: string;
  url: string;
}

/**
 * The panel's own two layout numbers, written out rather than imported from
 * `ReviewMarker.tsx`: an assertion built from the same constant the component
 * positions with would still hold if both moved together, and "the panel is
 * 360 wide and at most 320 tall" is exactly what these tests are pinning.
 */
const PANEL_WIDTH_PX = 360;
const PANEL_MAX_HEIGHT_PX = 320;

/** jsdom's own viewport, restored after every test that changes it. */
const ORIGINAL_VIEWPORT_SIZE = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };

function setViewportSize(viewportSize: { innerWidth: number; innerHeight: number }): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: viewportSize.innerWidth,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: viewportSize.innerHeight,
  });
}

/**
 * Where the chip is on screen. jsdom has no layout engine -- every element
 * reports a zero rect -- so a placement test that did not stub this would be
 * asking the component where it puts a panel anchored to a 0x0 chip at the
 * top-left corner, which is the one position no clamp and no flip ever
 * changes.
 */
function stubChipRect(chipButton: HTMLElement, chipPosition: { top: number; left: number }): void {
  const CHIP_SIDE_PX = 16; // `h-4 min-w-4`
  chipButton.getBoundingClientRect = () =>
    ({
      top: chipPosition.top,
      bottom: chipPosition.top + CHIP_SIDE_PX,
      left: chipPosition.left,
      right: chipPosition.left + CHIP_SIDE_PX,
      width: CHIP_SIDE_PX,
      height: CHIP_SIDE_PX,
      x: chipPosition.left,
      y: chipPosition.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function buildReviewItem(overrides: Partial<crm.ReviewItem> = {}): crm.ReviewItem {
  return {
    tenantId: "tenant_1",
    reviewItemId: "rev_1",
    reason: "UNMAPPED_STATUS",
    reviewStatus: "OPEN",
    sourceSheet: "2024 Cases",
    sourceRow: 412,
    caseRef: TEST_CASE_REF,
    fieldName: "Status",
    rawValue: "wating on embassy",
    createdAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * Real hooks, real client, stubbed `fetch` -- `AgentPanel.test.tsx`'s pattern.
 *
 * What these tests are about is WHEN a request is made (not on render; on
 * open), which request it is (PUT .../resolve, the route that exists, rather
 * than the POST spec §7 describes), and what the screen does with the answer.
 * A mocked hook cannot be wrong about any of the three, so it cannot prove any
 * of them.
 *
 * The summary is served from the ids that are still OPEN, so resolving really
 * does shrink the next summary response -- which is what makes the marker's
 * count fall for the reason production makes it fall.
 */
function stubReviewFetch(options: {
  fieldItemIds?: string[];
  mergeItemIds?: string[];
  reviewItemsById?: Record<string, crm.ReviewItem>;
  resolveFailuresByReviewItemId?: Record<string, { status: number; message: string }>;
}): RequestLogEntry[] {
  const requestLog: RequestLogEntry[] = [];
  const resolvedReviewItemIds = new Set<string>();
  const reviewItemsById = options.reviewItemsById ?? {};
  const resolveFailures = options.resolveFailuresByReviewItemId ?? {};

  function stillOpen(reviewItemIds: string[]): string[] {
    return reviewItemIds.filter((reviewItemId) => !resolvedReviewItemIds.has(reviewItemId));
  }

  function jsonResponse(payload: unknown) {
    return Promise.resolve({ ok: true, status: 200, json: async () => payload });
  }

  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({ method: requestMethod, url: requestUrl });

    if (requestUrl.endsWith("/review/summary")) {
      const openFieldItemIds = stillOpen(options.fieldItemIds ?? []);
      const openMergeItemIds = stillOpen(options.mergeItemIds ?? []);
      const hasOpenWork = openFieldItemIds.length > 0 || openMergeItemIds.length > 0;
      return jsonResponse({
        entries: hasOpenWork
          ? [{ caseRef: TEST_CASE_REF, fieldItemIds: openFieldItemIds, mergeItemIds: openMergeItemIds }]
          : [],
        unreadableReviewItemIds: [],
      });
    }

    const resolveMatch = /\/review\/([^/]+)\/resolve$/.exec(requestUrl);
    if (resolveMatch !== null) {
      const reviewItemId = resolveMatch[1]!;
      const failure = resolveFailures[reviewItemId];
      if (failure !== undefined) {
        return Promise.resolve({
          ok: false,
          status: failure.status,
          json: async () => ({ code: "CONFLICT", message: failure.message }),
        });
      }
      resolvedReviewItemIds.add(reviewItemId);
      return jsonResponse({ ...reviewItemsById[reviewItemId], reviewStatus: "DISMISSED" });
    }

    const itemMatch = /\/review\/([^/]+)$/.exec(requestUrl);
    if (itemMatch !== null) return jsonResponse(reviewItemsById[itemMatch[1]!]);

    throw new Error(`Unexpected request in this test: ${requestMethod} ${requestUrl}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return requestLog;
}

/** Every `getReviewItem` in the log, by id -- the summary read is not one. */
function itemFetchesIn(requestLog: RequestLogEntry[]): string[] {
  return requestLog
    .filter((entry) => entry.method === "GET" && !entry.url.endsWith("/review/summary"))
    .map((entry) => /\/review\/([^/]+)$/.exec(entry.url)?.[1] ?? entry.url);
}

/**
 * What `LedgerPage` does, reduced to one row: read the summary once, hand this
 * case its own entry. The marker's count falls when the SUMMARY says it has
 * (R69), so a test that passed a fixed `entry` prop could never observe the
 * mechanism that makes it fall.
 */
function ReviewMarkerForCase() {
  const reviewSummaryQuery = useReviewSummary();
  const reviewEntry = reviewSummaryQuery.data?.entries.find(
    (summaryEntry) => summaryEntry.caseRef === TEST_CASE_REF,
  );
  // These tests drive the chip with the mouse, so `isFocusedRow` changes
  // nothing they assert -- it governs the chip's TAB reachability only (R74).
  return <ReviewMarker caseRef={TEST_CASE_REF} entry={reviewEntry} isFocusedRow={true} />;
}

function renderMarkerForCase(element: ReactElement = <ReviewMarkerForCase />) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setViewportSize(ORIGINAL_VIEWPORT_SIZE);
});
