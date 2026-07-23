import type {
  ActivityEvent,
  Application,
  ApplicationDocument,
  ApplicationStatus,
  CountryProduct,
  DocType,
  PaymentStatus,
} from "@rgs/shared";

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? "";

export class ApiRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiFetch<ResponseType>(
  path: string,
  options: { method?: string; body?: unknown; idToken?: string | null } = {},
): Promise<ResponseType> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.idToken ? { authorization: `Bearer ${options.idToken}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = responsePayload as { code?: string; message?: string };
    throw new ApiRequestError(
      response.status,
      problem.code ?? "UNKNOWN",
      problem.message ?? `Request failed (${response.status})`,
    );
  }
  return responsePayload as ResponseType;
}

/** Website enquiry captured from the marketing site (see services/api/src/domain/leads.ts). */
export interface Lead {
  fullName: string;
  phone: string;
  topic: string;
  message: string;
  leadId: string;
  createdAt: string;
}

export interface ReviewDocumentInput {
  applicationId: string;
  docType: DocType;
  travellerIndex: number;
  decision: "APPROVED" | "REJECTED";
  userEmail: string;
  rejectReason?: string;
}

export const adminApi = {
  listApplications: (idToken: string, status: ApplicationStatus) =>
    apiFetch<Application[]>(`/api/v1/admin/applications?status=${status}`, { idToken }),

  getApplication: (idToken: string, applicationId: string) =>
    apiFetch<{ application: Application; documents: ApplicationDocument[] }>(
      `/api/v1/admin/applications/${applicationId}`,
      { idToken },
    ),

  transition: (
    idToken: string,
    applicationId: string,
    toStatus: ApplicationStatus,
    userEmail: string,
  ) =>
    apiFetch<Application>(`/api/v1/admin/applications/${applicationId}/transition`, {
      method: "POST",
      body: { toStatus, userEmail },
      idToken,
    }),

  setPayment: (
    idToken: string,
    applicationId: string,
    toPaymentStatus: PaymentStatus,
    userEmail: string,
  ) =>
    apiFetch<Application>(`/api/v1/admin/applications/${applicationId}/payment`, {
      method: "POST",
      body: { toPaymentStatus, userEmail },
      idToken,
    }),

  reviewDocument: (idToken: string, input: ReviewDocumentInput) =>
    apiFetch<ApplicationDocument>("/api/v1/admin/documents/review", {
      method: "POST",
      body: input,
      idToken,
    }),

  addNote: (idToken: string, applicationId: string, noteText: string) =>
    apiFetch<Application>(`/api/v1/admin/applications/${applicationId}/notes`, {
      method: "POST",
      body: { noteText },
      idToken,
    }),

  listActivity: (idToken: string, options: { userId?: string; daysBack?: number } = {}) => {
    const queryParams = new URLSearchParams();
    if (options.userId) queryParams.set("userId", options.userId);
    if (options.daysBack !== undefined) queryParams.set("daysBack", String(options.daysBack));
    const queryString = queryParams.toString();
    return apiFetch<ActivityEvent[]>(
      `/api/v1/admin/activity${queryString ? `?${queryString}` : ""}`,
      { idToken },
    );
  },

  listLeads: (idToken: string) => apiFetch<Lead[]>("/api/v1/admin/leads", { idToken }),

  listCountries: (idToken: string) =>
    apiFetch<CountryProduct[]>("/api/v1/admin/config/countries", { idToken }),

  putCountry: (idToken: string, countryProduct: CountryProduct) =>
    apiFetch<CountryProduct>("/api/v1/admin/config/countries", {
      method: "PUT",
      body: countryProduct,
      idToken,
    }),

  seedCountries: (idToken: string) =>
    apiFetch<{ seededCount: number }>("/api/v1/admin/config/seed", {
      method: "POST",
      idToken,
    }),
};
