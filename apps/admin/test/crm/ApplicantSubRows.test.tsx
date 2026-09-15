import { render, screen, within } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { ApplicantSubRows } from "../../src/crm/ledger/ApplicantSubRows";
import { useCase } from "../../src/crm/api/hooks";

/**
 * `<ApplicantSubRows>` reacts to a case fetch -- it does not own one. Mocked
 * at the hook boundary, the same way `LedgerPage.test.tsx` mocks
 * `useLedgerRows`/`usePartners`, so this file is about what the component
 * draws in each of the three states `useCase` can hand it (loading, error,
 * loaded) rather than about react-query or `crmClient`, both of which have
 * their own tests (hooks.test.ts, crmClient.test.ts).
 */
vi.mock("../../src/crm/api/hooks", () => ({
  useCase: vi.fn(),
}));

const mockedUseCase = vi.mocked(useCase);

/**
 * `useCase` is typed as `UseQueryResult<crm.CrmCase, Error>`, a large
 * discriminated union covering every fetch state. This component reads only
 * `data`, `isLoading` and `isError`, so the double assertion confines the
 * "this is not really the full union" lie to one place -- copied deliberately
 * from `LedgerPage.test.tsx`'s `fakeQueryResult` rather than invented here.
 */
function fakeCaseQueryResult(
  overrides: Partial<UseQueryResult<crm.CrmCase, Error>>,
): UseQueryResult<crm.CrmCase, Error> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<crm.CrmCase, Error>;
}

function buildApplicant(overrides: Partial<crm.CaseApplicant> = {}): crm.CaseApplicant {
  return {
    applicantRef: "A1",
    travellerId: "traveller_1",
    passportNumber: "Z1234567",
    custody: "WITH_RGS",
    outcome: "PENDING",
    ...overrides,
  };
}

function buildCase(applicants: crm.CaseApplicant[]): crm.CrmCase {
  return {
    tenantId: "tenant_1",
    caseId: "case_1",
    caseRef: "RGS-1001",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    lineItems: [],
    totalInr: 12_000,
    applicants,
    watchdogOverrides: {},
    mutedRules: [],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
  };
}

/** The loaded-and-successful state, which most tests below start from. */
function stubLoadedCase(applicants: crm.CaseApplicant[]): void {
  mockedUseCase.mockReturnValue(fakeCaseQueryResult({ data: buildCase(applicants) }));
}

describe("ApplicantSubRows", () => {
  it("lists each applicant's ref, passport, custody and outcome", () => {
    stubLoadedCase([
      buildApplicant({ applicantRef: "A1", passportNumber: "Z1234567", custody: "WITH_RGS", outcome: "PENDING" }),
      buildApplicant({
        applicantRef: "A2",
        travellerId: "traveller_2",
        passportNumber: "K7654321",
        custody: "AT_EMBASSY",
        outcome: "APPROVED",
      }),
    ]);

    render(<ApplicantSubRows caseId="case_1" />);

    const applicantRows = screen.getAllByTestId("applicant-subrow");
    expect(applicantRows).toHaveLength(2);

    // R45: the line is keyed by `applicantRef`, NOT a traveller name --
    // `CaseApplicantSchema` carries no name and this app has no by-id
    // traveller read. A test asserting on a name would be asserting on
    // something the component cannot obtain.
    expect(within(applicantRows[0]!).getByText("A1")).toBeInTheDocument();
    expect(within(applicantRows[0]!).getByText("Z1234567")).toBeInTheDocument();
    expect(within(applicantRows[0]!).getByText("With us")).toBeInTheDocument();
    expect(within(applicantRows[0]!).getByText("Pending")).toBeInTheDocument();

    expect(within(applicantRows[1]!).getByText("A2")).toBeInTheDocument();
    expect(within(applicantRows[1]!).getByText("K7654321")).toBeInTheDocument();
    expect(within(applicantRows[1]!).getByText("At embassy")).toBeInTheDocument();
    expect(within(applicantRows[1]!).getByText("Approved")).toBeInTheDocument();
  });

  it("shows a loading line, not an empty list, while the case is fetching", () => {
    mockedUseCase.mockReturnValue(fakeCaseQueryResult({ isLoading: true }));

    render(<ApplicantSubRows caseId="case_1" />);

    expect(screen.getByTestId("applicant-subrows-loading")).toBeInTheDocument();
    // An expanded row that renders an empty rowgroup while its fetch is in
    // flight reads as "this case has no applicants", which is never true.
    expect(screen.queryByTestId("applicant-subrows")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("applicant-subrow")).toHaveLength(0);
  });

  it("says the applicants could not be loaded when the fetch fails", () => {
    mockedUseCase.mockReturnValue(
      fakeCaseQueryResult({ isError: true, error: new Error("network down") }),
    );

    render(<ApplicantSubRows caseId="case_1" />);

    const errorLine = screen.getByTestId("applicant-subrows-error");
    expect(errorLine).toHaveTextContent("The applicants for this case could not be loaded.");
    // `role="alert"` and not merely styled text: a desk agent using a screen
    // reader has to be told the disclosure failed, not handed silence.
    expect(errorLine).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("applicant-subrows")).not.toBeInTheDocument();
  });

  it("renders the same error line, never an empty rowgroup, for an empty applicant list", () => {
    // `CrmCaseSchema.applicants` is `.min(1)` -- a real case can never resolve
    // to zero applicants, so an empty array can only ever be a failure this
    // query did not itself flag as one. Rendering it as an ordinary empty
    // state would hide exactly that failure, so it takes the error path.
    stubLoadedCase([]);

    render(<ApplicantSubRows caseId="case_1" />);

    expect(screen.getByTestId("applicant-subrows-error")).toHaveTextContent(
      "The applicants for this case could not be loaded.",
    );
    expect(screen.queryByTestId("applicant-subrows")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("rowgroup")).toHaveLength(0);
  });

  it("renders courier mode and tracking number together when both are present", () => {
    stubLoadedCase([
      buildApplicant({ applicantRef: "A1", courierMode: "SPEEDPOST", trackingNumber: "EE123456789IN" }),
    ]);

    render(<ApplicantSubRows caseId="case_1" />);

    // The human courier label, not the raw enum -- and the tracking number on
    // the SAME line, because a mode without its tracking number is not
    // something a desk agent can chase.
    expect(screen.getByText("Speed Post · EE123456789IN")).toBeInTheDocument();
  });

  it("names the courier mode alone when there is no tracking number yet", () => {
    stubLoadedCase([buildApplicant({ applicantRef: "A1", courierMode: "DTDC" })]);

    render(<ApplicantSubRows caseId="case_1" />);

    expect(screen.getByText("DTDC")).toBeInTheDocument();
  });

  it("says 'Not couriered' rather than going blank when courierMode is absent", () => {
    stubLoadedCase([buildApplicant({ applicantRef: "A1" })]);

    render(<ApplicantSubRows caseId="case_1" />);

    // A blank cell here is ambiguous between "not couriered" and "we failed
    // to read the courier", which are different answers to a desk agent
    // asking where a passport is.
    expect(screen.getByText("Not couriered")).toBeInTheDocument();
  });

  it("falls back to 'No passport on file' when the applicant has no passport number", () => {
    stubLoadedCase([buildApplicant({ applicantRef: "A1", passportNumber: undefined })]);

    render(<ApplicantSubRows caseId="case_1" />);

    expect(screen.getByText("No passport on file")).toBeInTheDocument();
  });
});
