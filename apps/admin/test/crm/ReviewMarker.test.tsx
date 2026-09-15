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
    render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", fieldItemIds: ["rev_1", "rev_2"], mergeItemIds: [] }} />);
    expect(screen.getByRole("button", { name: /2 import problems/i })).toBeInTheDocument();
  });

  it("marks a merge candidate differently from a field problem", () => {
    const { container: fieldMarker } = render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", fieldItemIds: ["rev_1"], mergeItemIds: [] }} />);
    const { container: mergeMarker } = render(<ReviewMarker caseRef="RGS-1002" entry={{ caseRef: "RGS-1002", fieldItemIds: [], mergeItemIds: ["rev_9"] }} />);

    expect(mergeMarker.textContent).toMatch(/may be a duplicate/i);
    expect(mergeMarker.firstElementChild?.className).not.toBe(fieldMarker.firstElementChild?.className);
  });

  it("renders no marker at all for a clean case", () => {
    const { container } = render(<ReviewMarker caseRef="RGS-1001" entry={undefined} />);
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
});

const TEST_CASE_REF = "RGS-1001";

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

interface RequestLogEntry {
  method: string;
  url: string;
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
  return <ReviewMarker caseRef={TEST_CASE_REF} entry={reviewEntry} />;
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
});
