import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { NewCaseDrawer } from "../../src/crm/newCase/NewCaseDrawer";

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

interface LoggedRequest {
  method: string;
  url: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

/**
 * A URL-routed `fetch` stub. The one behaviour worth pinning is the ORDER of
 * calls the drawer makes and what it sends in each: partner first, then a
 * passport lookup per applicant (create the traveller only on a 404), then
 * the case itself with the ids those calls returned.
 */
function renderDrawer(options: { passportIsKnown?: boolean; caseWriteFails?: boolean } = {}) {
  const requestLog: LoggedRequest[] = [];
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({
      method: requestMethod,
      url: requestUrl,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (requestUrl.endsWith("/config/countries")) {
      return jsonResponse(200, {
        countryProducts: [{ countryCode: "AE", countryName: "United Arab Emirates" }],
        unreadableCountryProductIds: [],
      });
    }
    if (requestMethod === "GET" && requestUrl.endsWith("/crm/partners")) {
      return jsonResponse(200, {
        partners: [{ partnerId: "partner_1", canonicalName: "Skyline Travels" }],
        unreadablePartnerIds: [],
      });
    }
    if (requestMethod === "POST" && requestUrl.endsWith("/crm/partners")) {
      return jsonResponse(201, { partnerId: "partner_new", canonicalName: "Walk-in Desk" });
    }
    if (requestUrl.includes("/travellers/by-passport/")) {
      return options.passportIsKnown === true
        ? jsonResponse(200, { travellerId: "traveller_known", fullName: "Asha Rao", passportNumber: "Z1234567" })
        : jsonResponse(404, { code: "NOT_FOUND", message: "Traveller not found" });
    }
    if (requestMethod === "POST" && requestUrl.endsWith("/crm/travellers")) {
      return jsonResponse(201, { travellerId: "traveller_created", fullName: "Asha Rao" });
    }
    if (requestMethod === "POST" && requestUrl.endsWith("/crm/cases")) {
      return options.caseWriteFails === true
        ? jsonResponse(409, { code: "CONFLICT", message: "A case with REF RGS-1 already exists" })
        : jsonResponse(201, { caseId: "case_created", caseRef: "RGS-1" });
    }
    return jsonResponse(500, { code: "UNEXPECTED", message: `Unexpected request ${requestMethod} ${requestUrl}` });
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/crm"]}>
          <Routes>
            <Route path="/crm" element={<NewCaseDrawer onClose={onClose} />} />
            <Route path="/crm/cases/:caseId" element={<p>Landed on the case page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { requestLog, onClose };
}

async function fillTheCommonFields() {
  fireEvent.change(screen.getByPlaceholderText(/RGS-2026/), { target: { value: " RGS-1 " } });
  await screen.findByRole("option", { name: "Skyline Travels" });
  await screen.findByRole("option", { name: "United Arab Emirates" });
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "AE" } });
  fireEvent.change(screen.getByLabelText("Received"), { target: { value: "2026-09-16" } });
  fireEvent.change(screen.getByLabelText("Applicant 1 name"), { target: { value: "Asha Rao" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewCaseDrawer", () => {
  it("refuses to submit until every required field is filled, naming the first gap", async () => {
    const { requestLog } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the case a REF.");
    expect(requestLog.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("creates a new partner and a new traveller before the case, then lands on the case page", async () => {
    const { requestLog, onClose } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "__new_partner__" } });
    fireEvent.change(screen.getByLabelText("New partner name"), { target: { value: "Walk-in Desk" } });
    fireEvent.change(screen.getByLabelText("Passport"), { target: { value: "z1234567" } });
    fireEvent.change(screen.getByLabelText("Visa type"), { target: { value: "TOURIST" } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    const writes = requestLog.filter((request) => request.method === "POST" || request.url.includes("by-passport"));
    expect(writes.map((request) => `${request.method} ${request.url.split("/admin/crm")[1]}`)).toEqual([
      "POST /partners",
      "GET /travellers/by-passport/Z1234567",
      "POST /travellers",
      "POST /cases",
    ]);
    expect(writes[0]!.body).toEqual({ canonicalName: "Walk-in Desk" });
    expect(writes[2]!.body).toEqual({ fullName: "Asha Rao", passportNumber: "Z1234567" });
    expect(writes[3]!.body).toEqual({
      caseRef: "RGS-1",
      caseType: "VISA",
      partnerId: "partner_new",
      destinationCountry: "AE",
      visaType: "TOURIST",
      receivedDate: "2026-09-16",
      applicants: [{ applicantRef: "A1", travellerId: "traveller_created", passportNumber: "Z1234567" }],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("attaches an applicant whose passport is already on file instead of creating a duplicate traveller", async () => {
    const { requestLog } = renderDrawer({ passportIsKnown: true });
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.change(screen.getByLabelText("Passport"), { target: { value: "Z1234567" } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    expect(requestLog.some((request) => request.method === "POST" && request.url.endsWith("/travellers"))).toBe(false);
    const caseWrite = requestLog.find((request) => request.method === "POST" && request.url.endsWith("/cases"));
    expect(caseWrite!.body).toMatchObject({
      partnerId: "partner_1",
      applicants: [{ applicantRef: "A1", travellerId: "traveller_known" }],
    });
  });

  it("shows the server's failure sentence and stays open when the case write is rejected", async () => {
    const { onClose } = renderDrawer({ caseWriteFails: true });
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The case was not created: A case with REF RGS-1 already exists",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Landed on the case page")).toBeNull();
  });

  it("sends collection date, entry type, and remarks when filled, and hides entry type off a visa case", async () => {
    const { requestLog } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.change(screen.getByLabelText("Collection date"), { target: { value: "2026-09-20" } });
    fireEvent.change(screen.getByLabelText("Entry type"), { target: { value: "MULTIPLE" } });
    fireEvent.change(screen.getByLabelText("Remarks"), { target: { value: "  Passport copy is faint  " } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    const caseWrite = requestLog.find((request) => request.method === "POST" && request.url.endsWith("/cases"));
    expect(caseWrite!.body).toMatchObject({
      caseType: "VISA",
      entryType: "MULTIPLE",
      expectedCollectionDate: "2026-09-20",
      remarks: "Passport copy is faint",
      receivedDate: "2026-09-16",
    });
    expect(caseWrite!.body).not.toHaveProperty("billingStatus");
    expect(caseWrite!.body).not.toHaveProperty("caseStatus");
  });

  it("omits blank optional fields and hides entry type when the case is not a visa", async () => {
    const { requestLog } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "ATTESTATION" } });
    expect(screen.queryByLabelText("Entry type")).toBeNull();
    expect(screen.queryByLabelText("Visa type")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    const caseWrite = requestLog.find((request) => request.method === "POST" && request.url.endsWith("/cases"));
    expect(caseWrite!.body).not.toHaveProperty("entryType");
    expect(caseWrite!.body).not.toHaveProperty("expectedCollectionDate");
    expect(caseWrite!.body).not.toHaveProperty("remarks");
    expect(caseWrite!.body).not.toHaveProperty("visaType");
  });

  it("closes on Escape", () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
