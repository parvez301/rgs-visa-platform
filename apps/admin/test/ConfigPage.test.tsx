import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { COUNTRY_PRODUCTS, type CountryProduct } from "@rgs/shared";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigPage } from "../src/pages/ConfigPage";
import { adminApi } from "../src/lib/adminApi";
import { AuthContext, type AuthState } from "../src/lib/auth";

vi.mock("../src/lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/adminApi")>();
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listCountries: vi.fn(),
      putCountry: vi.fn(),
      seedCountries: vi.fn(),
    },
  };
});

const ownerAuth: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "owner@rgs.test",
  idToken: "test-token",
  roles: ["Owner"],
  primaryRole: "Owner",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

const ae: CountryProduct = {
  ...COUNTRY_PRODUCTS.find((countryProduct) => countryProduct.countryCode === "AE")!,
  requiredDocuments: [
    { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
    { label: "Passport-size photo", portalDocType: "PHOTO" },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuth}>
        <MemoryRouter>
          <ConfigPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

async function openAeDrawer(user: ReturnType<typeof userEvent.setup>) {
  const countryCell = await screen.findByText("United Arab Emirates");
  const row = countryCell.closest("tr")!;
  await user.click(within(row).getByRole("button", { name: "Edit" }));
}

beforeEach(() => {
  vi.mocked(adminApi.listCountries).mockResolvedValue([ae]);
  vi.mocked(adminApi.putCountry).mockImplementation(async (_token, product) => product);
});

describe("ConfigPage requiredDocuments editor", () => {
  it("lets an admin add a document label and optional portal DocType", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.type(screen.getByLabelText("Document label"), "Office form");
    await user.click(screen.getByRole("button", { name: "Add document" }));
    expect(screen.getByText("Office form")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Portal upload for Office form"), "ITR");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(adminApi.putCountry).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(adminApi.putCountry).mock.calls[0]![1];
    expect(saved.requiredDocuments).toEqual([
      ...ae.requiredDocuments,
      { label: "Office form", portalDocType: "ITR" },
    ]);
    expect("docsRequired" in saved).toBe(false);
  });

  it("adds a label with no portal DocType by default", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.type(screen.getByLabelText("Document label"), "Office form");
    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(adminApi.putCountry).toHaveBeenCalled());
    const saved = vi.mocked(adminApi.putCountry).mock.calls[0]![1];
    expect(saved.requiredDocuments.at(-1)).toEqual({ label: "Office form" });
  });

  it("removes and reorders documents", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.click(screen.getByRole("button", { name: "Move Passport-size photo up" }));
    await user.click(screen.getByRole("button", { name: "Remove Passport bio page" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(adminApi.putCountry).toHaveBeenCalled());
    const saved = vi.mocked(adminApi.putCountry).mock.calls[0]![1];
    expect(saved.requiredDocuments).toEqual([
      { label: "Passport-size photo", portalDocType: "PHOTO" },
    ]);
  });

  it("blocks adding a duplicate label", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.type(screen.getByLabelText("Document label"), "passport bio page");
    await user.click(screen.getByRole("button", { name: "Add document" }));
    expect(screen.getByText(/already in the list/i)).toBeInTheDocument();
  });

  it("blocks a portal DocType used by two rows", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.type(screen.getByLabelText("Document label"), "Second photo");
    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.selectOptions(screen.getByLabelText("Portal upload for Second photo"), "PHOTO");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(adminApi.putCountry).not.toHaveBeenCalled();
    expect(screen.getByText(/portal document type.*once/i)).toBeInTheDocument();
  });

  it("blocks activating a Fulfilled country with an empty checklist", async () => {
    const user = userEvent.setup();
    renderPage();
    await openAeDrawer(user);

    await user.click(screen.getByRole("button", { name: "Remove Passport bio page" }));
    await user.click(screen.getByRole("button", { name: "Remove Passport-size photo" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(adminApi.putCountry).not.toHaveBeenCalled();
    expect(screen.getByText(/without a documents checklist/i)).toBeInTheDocument();
  });
});
