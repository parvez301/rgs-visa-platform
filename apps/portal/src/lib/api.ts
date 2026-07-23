import type {
  Application,
  ApplicationDocument,
  ApplicationEssentials,
  CountryProduct,
  DocType,
  Traveller,
  WizardStep,
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

export const portalApi = {
  listCountries: () => apiFetch<CountryProduct[]>("/api/v1/config/countries"),

  listMyApplications: (idToken: string) =>
    apiFetch<Application[]>("/api/v1/applications", { idToken }),

  getApplication: (idToken: string, applicationId: string) =>
    apiFetch<{ application: Application; documents: ApplicationDocument[] }>(
      `/api/v1/applications/${applicationId}`,
      { idToken },
    ),

  createDraft: (idToken: string, countryCode: string) =>
    apiFetch<Application>("/api/v1/applications", {
      method: "POST",
      body: { countryCode },
      idToken,
    }),

  patchDraft: (
    idToken: string,
    applicationId: string,
    patch: {
      travellers?: Traveller[];
      essentials?: ApplicationEssentials;
      stepReached?: WizardStep;
    },
  ) =>
    apiFetch<Application>(`/api/v1/applications/${applicationId}`, {
      method: "PATCH",
      body: patch,
      idToken,
    }),

  submitApplication: (idToken: string, applicationId: string) =>
    apiFetch<Application>(`/api/v1/applications/${applicationId}/submit`, {
      method: "POST",
      idToken,
    }),

  presignDocumentUpload: (
    idToken: string,
    applicationId: string,
    docType: DocType,
    travellerIndex: number,
    contentType: string,
  ) =>
    apiFetch<{ uploadUrl: string; objectKey: string }>(
      `/api/v1/applications/${applicationId}/documents/presign`,
      { method: "POST", body: { docType, travellerIndex, contentType }, idToken },
    ),

  recordDocumentUpload: (
    idToken: string,
    applicationId: string,
    docType: DocType,
    travellerIndex: number,
    objectKey: string,
  ) =>
    apiFetch<ApplicationDocument>(`/api/v1/applications/${applicationId}/documents`, {
      method: "POST",
      body: { docType, travellerIndex, objectKey },
      idToken,
    }),

  presignDocumentDownload: (
    idToken: string,
    applicationId: string,
    docType: DocType,
    travellerIndex: number,
  ) =>
    apiFetch<{ downloadUrl: string }>(
      `/api/v1/applications/${applicationId}/documents/download?docType=${docType}&travellerIndex=${travellerIndex}`,
      { idToken },
    ),
};

export async function uploadFileToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Upload failed (${uploadResponse.status})`);
  }
}
