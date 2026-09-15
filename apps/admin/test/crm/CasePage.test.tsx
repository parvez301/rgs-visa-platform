import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { AgentPanelProvider } from "../../src/crm/agent/AgentPanelProvider";
import { CasePage } from "../../src/crm/case/CasePage";
import type { CrmEventView } from "../../src/crm/api/crmClient";

/**
 * Rendered through the real hooks against a stubbed, request-logging `fetch`
 * -- the `LedgerEditingIntegration.test.tsx` pattern, not the hook-mocking one
 * -- because the assertion the brief actually cares about on this screen is
 * about a REQUEST PATH: "edits one applicant's custody without touching its
 * sibling" is only true if the `applicantRef` in the URL is the one whose
 * control was used. A mocked hook cannot be wrong about that, so it cannot
 * prove it either.
 *
 * The stub routes by URL rather than by a FIFO queue of deferreds: this screen
 * fires three GETs on mount (the case, its events, the partner list) and their
 * settle order is not something any test here should have to depend on.
 */
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
  body: unknown;
}

function buildCase(overrides: Partial<crm.CrmCase> = {}): crm.CrmCase {
  return {
    tenantId: "tenant_1",
    caseId: "case_1",
    caseRef: "RGS-1001",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "AE",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-01",
    submissionDate: "2026-03-05",
    appointmentDate: "2026-03-09",
    expectedCollectionDate: "2026-03-14",
    lineItems: [],
    totalInr: 0,
    applicants: [
      {
        applicantRef: "A1",
        travellerId: "trv_1",
        passportNumber: "Z1234567",
        custody: "WITH_RGS",
        outcome: "PENDING",
      },
      {
        applicantRef: "A2",
        travellerId: "trv_2",
        passportNumber: "Z7654321",
        custody: "WITH_RGS",
        outcome: "PENDING",
      },
    ],
    watchdogOverrides: {},
    mutedRules: [],
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  };
}

function renderCasePage(
  options: {
    caseRecord?: crm.CrmCase;
    events?: CrmEventView[];
    caseReadFails?: boolean;
  } = {},
) {
  const caseRecord = options.caseRecord ?? buildCase();
  const events = options.events ?? [];
  const requestLog: RequestLogEntry[] = [];

  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({
      method: requestMethod,
      url: requestUrl,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    if (requestUrl.endsWith("/partners")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          partners: [{ partnerId: "partner_1", canonicalName: "Skyline Travels" }],
          unreadablePartnerIds: [],
        }),
      });
    }
    if (requestUrl.endsWith("/events")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ events }) });
    }
    if (requestMethod === "GET" && options.caseReadFails === true) {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ code: "INTERNAL", message: "The case could not be read from storage" }),
      });
    }
    // The case GET, and every axis PUT: both answer with the full case.
    return Promise.resolve({ ok: true, status: 200, json: async () => caseRecord });
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const result = render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>
        <UndoToastProvider>
          {/*
            Task 15: `CrmLayout`'s right column now renders `AgentPanel`, whose
            conversation lives in a provider mounted above the routes in
            `main.tsx` (R63). The URL-routed `fetch` stub above answers the
            panel's three GETs with `{}`, which every one of its readers treats
            as an empty list -- this file asserts nothing about the panel.
          */}
          <AgentPanelProvider>
            <MemoryRouter initialEntries={["/crm/cases/case_1"]}>
              <Routes>
                <Route path="/crm/cases/:caseId" element={<CasePage />} />
              </Routes>
            </MemoryRouter>
          </AgentPanelProvider>
        </UndoToastProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );

  return { ...result, requestLog };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CasePage", () => {
  it("shows the shared case fields once, not repeated down the applicants", async () => {
    renderCasePage({ caseRecord: buildCase() });

    // The REF is the case's name; an applicant row that repeats it is the
    // spreadsheet shape spec §5 exists to replace (one row per applicant,
    // every shared field copied down it).
    expect(await screen.findByRole("heading", { name: "RGS-1001" })).toBeInTheDocument();
    expect(screen.getAllByText("RGS-1001")).toHaveLength(1);

    // Shared fields: present once each, at the top, never on an applicant row.
    expect(screen.getAllByText("Skyline Travels")).toHaveLength(1);
    expect(screen.getAllByText("Visa · Tourist")).toHaveLength(1);
    expect(screen.getAllByText("2026-03-01")).toHaveLength(1);

    const applicantRows = screen.getAllByTestId("case-applicant-row");
    expect(applicantRows).toHaveLength(2);
    for (const applicantRow of applicantRows) {
      expect(applicantRow.textContent).not.toContain("RGS-1001");
      expect(applicantRow.textContent).not.toContain("Skyline Travels");
    }
  });

  it("lists line items with their quantity, unit price and the case total", async () => {
    // LineItem.amountInr is a UNIT price and totalInr is the sum of
    // amountInr × quantity across items (schemas.ts). Rendering amountInr as
    // a line total is wrong for any quantity above one.
    renderCasePage({
      caseRecord: buildCase({
        lineItems: [
          { code: "VISA_FEE", label: "Visa fee", amountInr: 5000, quantity: 2, kind: "GOVT_FEE" },
          { code: "COURIER", label: "Courier", amountInr: 500, quantity: 3, kind: "ADDON" },
        ],
        totalInr: 11_500,
      }),
    });

    const lineItemRows = await screen.findAllByTestId("case-line-item-row");
    expect(lineItemRows).toHaveLength(2);

    expect(lineItemRows[0]!.textContent).toContain("Visa fee");
    expect(lineItemRows[0]!.textContent).toContain("2");
    // The unit price AND the line total, both, and they differ: a screen that
    // prints only `amountInr` passes an assertion for "₹5,000" while telling a
    // desk agent this line cost ₹5,000 when it cost ₹10,000.
    expect(lineItemRows[0]!.textContent).toContain("₹5,000");
    expect(lineItemRows[0]!.textContent).toContain("₹10,000");

    expect(lineItemRows[1]!.textContent).toContain("₹500");
    expect(lineItemRows[1]!.textContent).toContain("₹1,500");

    expect(screen.getByTestId("case-total").textContent).toContain("₹11,500");
  });

  it("edits one applicant's custody without touching its sibling", async () => {
    const user = userEvent.setup();
    const { requestLog } = renderCasePage({ caseRecord: buildCase() });

    const siblingCustodyControl = await screen.findByLabelText("Custody for applicant A2");
    await user.selectOptions(siblingCustodyControl, "AT_EMBASSY");

    await waitFor(() => {
      expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
    });
    const [custodyWrite] = requestLog.filter((entry) => entry.method === "PUT");
    // The applicantRef in the PATH is the whole assertion: a route built from
    // the first applicant, or from the case alone, would move A1's passport
    // while the agent was looking at A2's row.
    expect(custodyWrite!.url).toContain("/cases/case_1/applicants/A2/custody");
    expect(custodyWrite!.url).not.toContain("/applicants/A1/");
    expect(custodyWrite!.body).toEqual({ toCustody: "AT_EMBASSY" });
  });

  it("offers no way to clear the visa type, because the PUT body cannot unset one", async () => {
    // Fix round 1, F3. An `<option value="">` here sent `{ visaType: "" }`,
    // which `cases.ts:152` counts as a change and `CrmCaseSchema.parse` then
    // rejects on `z.enum(VISA_TYPES)` -- so the field cleared optimistically
    // and snapped back with no explanation (a non-409 rolls back silently by
    // design). The Ledger's own editor never offered one either
    // (`EditableCell.tsx`'s visaType branch lists only `crm.VISA_TYPES`).
    const user = userEvent.setup();
    const { requestLog } = renderCasePage({ caseRecord: buildCase({ visaType: "TOURIST" }) });

    const visaTypeControl = await screen.findByLabelText("Visa type");
    const emptyOptionValues = within(visaTypeControl)
      .getAllByRole("option")
      .map((optionElement) => (optionElement as HTMLOptionElement).value)
      .filter((optionValue) => optionValue === "");
    expect(emptyOptionValues).toHaveLength(0);

    // And the control still works for a real value, so this is not passing
    // because the whole select went missing.
    await user.selectOptions(visaTypeControl, "WORK");
    await waitFor(() => {
      expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
    });
    expect(requestLog.filter((entry) => entry.method === "PUT")[0]!.body).toEqual({ visaType: "WORK" });
  });

  it("commits the appointment date once, when the human confirms it, not on every keystroke", async () => {
    // Fix round 1, F4. React's `onChange` on a date input is the native
    // `input` event: typing a year digit by digit walks the value through
    // 0002-03-20, 0020-03-20, 0202-03-20 before reaching 2026-03-20, and each
    // of those is a COMPLETE, schema-valid date. Committing on change wrote
    // all four to the server. `fireEvent.change` rather than `user.type`
    // because that is exactly the sequence of values a date input hands React,
    // and it is the sequence -- not the typing -- this test is about.
    const { requestLog } = renderCasePage({ caseRecord: buildCase({ appointmentDate: "2026-03-09" }) });

    const appointmentDateControl = await screen.findByLabelText("Appointment date");
    for (const partiallyTypedDate of ["0002-03-20", "0020-03-20", "0202-03-20", "2026-03-20"]) {
      fireEvent.change(appointmentDateControl, { target: { value: partiallyTypedDate } });
    }
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(0);

    fireEvent.blur(appointmentDateControl);

    await waitFor(() => {
      expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
    });
    expect(requestLog.filter((entry) => entry.method === "PUT")[0]!.body).toEqual({
      appointmentDate: "2026-03-20",
    });
  });

  it("writes nothing when the appointment date is cleared, because the PUT body cannot unset it", async () => {
    // Fix round 1, F3's other half: `appointmentDate: ""` fails the schema's
    // `isoDate` regex, so an empty value is a no-op rather than a rejected
    // write that rolls back without saying why.
    const { requestLog } = renderCasePage({ caseRecord: buildCase({ appointmentDate: "2026-03-09" }) });

    const appointmentDateControl = await screen.findByLabelText("Appointment date");
    fireEvent.change(appointmentDateControl, { target: { value: "" } });
    fireEvent.blur(appointmentDateControl);

    await waitFor(() => {
      expect(screen.getByLabelText("Appointment date")).toHaveValue("");
    });
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(0);
  });

  it("shows a case that could not be loaded as an error, not as an empty case", async () => {
    renderCasePage({ caseReadFails: true });

    const failureNotice = await screen.findByRole("alert");
    expect(failureNotice.textContent).toContain("could not be loaded");
    // The server's own words, not a paraphrase.
    expect(failureNotice.textContent).toContain("The case could not be read from storage");

    // An empty shell is the failure mode this test exists to forbid: a screen
    // showing a heading, blank fields and an empty applicant table reads as a
    // case with nothing on it, which is a different (and false) claim.
    expect(screen.queryByTestId("case-applicant-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("case-total")).not.toBeInTheDocument();
  });

  it("renders the audit timeline the events endpoint returned", async () => {
    renderCasePage({
      caseRecord: buildCase(),
      events: [
        {
          eventId: "e1",
          eventType: "PROPOSAL_APPROVED",
          caseId: "case_1",
          actorEmail: "ops@rgs.test",
          meta: { autoApplied: true, toolName: "set_custody" },
          createdAt: "2026-03-04T10:00:00.000Z",
        },
      ],
    });

    const timelineEntry = await screen.findByTestId("timeline-entry");
    expect(within(timelineEntry).getByText(/Applied automatically/)).toBeInTheDocument();
  });
});
