import type {
  ActivityEvent,
  Application,
  ApplicationDocument,
  ApplicationStatus,
  CountryProduct,
  DocType,
  Notice,
  NoticeInput,
  PaymentStatus,
  User,
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

interface ApplicationListing {
  applications: Application[];
  unreadableApplicationIds: string[];
}

interface ActivityListing {
  events: ActivityEvent[];
  unreadableEventIds: string[];
}

/**
 * A stored row the API could not reassemble. It is skipped so one bad row
 * cannot take a whole screen down, but skipping it silently would make a
 * missing application indistinguishable from one never submitted -- so it is
 * at least said out loud where an operator reporting a problem can find it.
 */
function warnAboutUnreadable(entity: string, unreadableIds: string[]): void {
  if (unreadableIds.length === 0) return;
  console.warn(
    `${unreadableIds.length} ${entity}(s) could not be read and were left out: ${unreadableIds.join(", ")}`,
  );
}

export const adminApi = {
  // The API answers { applications, unreadableApplicationIds } so that one
  // malformed row cannot 500 the whole queue. The pages want the list, so it
  // is unwrapped here; a skipped row is reported rather than merely absent.
  listApplications: async (idToken: string, status: ApplicationStatus) => {
    const listing = await apiFetch<ApplicationListing>(
      `/api/v1/admin/applications?status=${status}`,
      { idToken },
    );
    warnAboutUnreadable("application", listing.unreadableApplicationIds);
    return listing.applications;
  },

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

  presignDocumentDownload: (
    idToken: string,
    applicationId: string,
    docType: string,
    travellerIndex: number,
  ) =>
    apiFetch<{ downloadUrl: string }>(
      `/api/v1/admin/applications/${applicationId}/documents/download?docType=${docType}&travellerIndex=${travellerIndex}`,
      { idToken },
    ),

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

  listActivity: async (idToken: string, options: { userId?: string; daysBack?: number } = {}) => {
    const queryParams = new URLSearchParams();
    if (options.userId) queryParams.set("userId", options.userId);
    if (options.daysBack !== undefined) queryParams.set("daysBack", String(options.daysBack));
    const queryString = queryParams.toString();
    const listing = await apiFetch<ActivityListing>(
      `/api/v1/admin/activity${queryString ? `?${queryString}` : ""}`,
      { idToken },
    );
    warnAboutUnreadable("activity event", listing.unreadableEventIds);
    return listing.events;
  },

  listLeads: (idToken: string) => apiFetch<Lead[]>("/api/v1/admin/leads", { idToken }),

  listUsers: (idToken: string) => apiFetch<User[]>("/api/v1/admin/users", { idToken }),

  listNotices: (idToken: string) => apiFetch<Notice[]>("/api/v1/admin/notices", { idToken }),

  upsertNotice: (idToken: string, noticeInput: NoticeInput) =>
    apiFetch<Notice>("/api/v1/admin/notices", {
      method: "PUT",
      body: noticeInput,
      idToken,
    }),

  deleteNotice: (idToken: string, noticeId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/admin/notices/${noticeId}`, {
      method: "DELETE",
      idToken,
    }),

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
