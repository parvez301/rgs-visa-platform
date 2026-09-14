import { crm, unwrapListingResponse } from "@rgs/shared";
import { ApiRequestError } from "../../lib/adminApi";

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? "";
const CRM_BASE = "/api/v1/admin/crm";

/**
 * A copy of `adminApi.ts`'s own `apiFetch`, not an import of it: that copy is
 * module-private, and its sibling listing helper (`fetchListing`) is shaped
 * around the visa-platform payloads. Copying these ~20 lines keeps the CRM
 * directory independent of a file this plan otherwise never touches -- the
 * one deliberate duplication in this plan.
 */
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

export interface LedgerPageResponse {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  nextCursor?: string;
  appliedQuery: { statuses: crm.CaseStatus[]; partnerId?: string; limit: number };
}

export interface LedgerLoad {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  /** True when the page cap stopped the walk before the cursor ran out. */
  truncated: boolean;
  appliedQuery: LedgerPageResponse["appliedQuery"];
}

/**
 * Mirrors `CrmEvent` (services/api/src/domain/crm/crmEvents.ts) at the wire
 * level. Not imported from there -- the admin app depends only on
 * `@rgs/shared`, never on `services/api` -- so this is the client's own
 * account of the same shape, kept beside the route that produces it.
 */
export type CrmEventType =
  | "CASE_CREATED"
  | "CASE_STATUS_CHANGED"
  | "CUSTODY_CHANGED"
  | "BILLING_CHANGED"
  | "CASE_UPDATED"
  | "APPLICANT_OUTCOME_CHANGED"
  | "LINE_ITEM_ADDED"
  | "PROPOSAL_APPROVED"
  | "PROPOSAL_DISCARDED"
  | "MEMORY_REMEMBERED";

export interface CrmEventView {
  eventId: string;
  eventType: CrmEventType;
  caseId: string;
  actorEmail: string;
  meta: Record<string, string | number | boolean>;
  createdAt: string;
}

/**
 * The six fields `PUT /cases/{caseId}` accepts (crmApi.ts's own
 * `UpdateCaseDetailsBody`, mirrored here at the wire level). Deliberately
 * NOT every field on `crm.CrmCase`: `caseStatus`, per-applicant `custody`,
 * per-applicant `outcome` and `billingStatus` each have their own route and
 * their own state machine, and a wider body here would let a caller walk
 * around all four.
 */
export interface UpdateCaseDetailsBody {
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  submissionDate?: string;
  appointmentDate?: string;
  expectedCollectionDate?: string;
}

/** Mirrors `OpenReviewSummaryEntry` (services/api/src/domain/crm/reviewQueue.ts). */
export interface OpenReviewSummaryEntry {
  caseRef: string;
  /** Items about one cell: a value that could not be read or mapped. */
  fieldItemIds: string[];
  /** Items about two rows: PROPOSED_GROUP, DUPLICATE_REF. */
  mergeItemIds: string[];
}

/** One tool call the model made, replayed back on the next turn. */
export interface AgentToolCallWire {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * One turn of agent conversation, mirroring `AgentMessage`
 * (services/api/src/agent/providers/types.ts) at the wire level -- this is
 * what the client both sends as `conversation` and receives back inside
 * `reply`-adjacent history it is expected to replay on the next call.
 */
export interface AgentMessageWire {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolCalls?: AgentToolCallWire[];
  toolCallId?: string;
  toolName?: string;
}

/** Mirrors `ProposedChange` (services/api/src/agent/approval.ts). */
export interface ProposalView {
  proposalId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable diff for the UI card: field, from, to. */
  summary: { field: string; from: string; to: string }[];
  caseId?: string;
  proposedBy: string;
  proposedAt: string;
  status: "PENDING" | "APPROVED" | "DISCARDED";
  decidedBy?: string;
  decidedAt?: string;
  discardReason?: string;
}

/** Mirrors `AgentTurnResult` (services/api/src/agent/loop.ts). */
export interface AgentTurnResponse {
  reply: string;
  proposals: ProposalView[];
  appliedChanges: ProposalView[];
  toolCallsMade: { toolName: string; kind: "read" | "write" }[];
  stoppedAtIterationCap: boolean;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/**
 * What `approveProposal` resolves to. `applyApprovedChange`
 * (services/api/src/agent/approval.ts) itself returns `Promise<unknown>`,
 * because the domain result differs by which write tool the proposal ran --
 * a case for `update_case_*`/`change_*` tools, a memory row for `remember`,
 * a plain acknowledgement for others. The client cannot narrow this further
 * without knowing which tool produced it, so it stays `unknown` rather than
 * claiming a shape the server itself does not commit to.
 */
export type ApprovalResult = unknown;

export const MAX_LEDGER_PAGES = 40;

async function fetchLedgerPage(
  idToken: string,
  params: { statuses?: crm.CaseStatus[]; partnerId?: string; limit?: number; cursor?: string },
): Promise<LedgerPageResponse> {
  const queryParams = new URLSearchParams();
  // Comma-joined, because API Gateway v2 collapses a repeated parameter into
  // exactly this and the route splits on commas (crmApi.ts parseLedgerStatuses).
  if (params.statuses !== undefined && params.statuses.length > 0) {
    queryParams.set("status", params.statuses.join(","));
  }
  if (params.partnerId !== undefined) queryParams.set("partnerId", params.partnerId);
  if (params.limit !== undefined) queryParams.set("limit", String(params.limit));
  if (params.cursor !== undefined) queryParams.set("cursor", params.cursor);
  const queryString = queryParams.toString();
  return apiFetch<LedgerPageResponse>(
    `${CRM_BASE}/cases/ledger${queryString ? `?${queryString}` : ""}`,
    { idToken },
  );
}

/**
 * Every row of the ledger, in as many requests as the cursor takes.
 *
 * The Ledger filters, sorts and searches client-side over the rows it holds
 * (spec §2.1 fixes the split), so "the rows it holds" has to be all of them --
 * about 1.4 MB projected, against 7-21 MB of full case records.
 *
 * Capped, and honest when the cap bites: a server bug that always answers with
 * a cursor would otherwise spin until the tab dies, and a ledger that quietly
 * stops at row 5,000 is a desk agent concluding a case does not exist.
 */
async function loadLedger(
  idToken: string,
  params: { statuses?: crm.CaseStatus[]; partnerId?: string },
): Promise<LedgerLoad> {
  const rows: crm.LedgerRow[] = [];
  const unreadableCaseIds: string[] = [];
  let cursor: string | undefined;
  let appliedQuery: LedgerPageResponse["appliedQuery"] = {
    statuses: params.statuses ?? [],
    ...(params.partnerId !== undefined ? { partnerId: params.partnerId } : {}),
    limit: 0,
  };
  let pagesRead = 0;

  do {
    const page = await fetchLedgerPage(idToken, { ...params, ...(cursor !== undefined ? { cursor } : {}) });
    rows.push(...page.rows);
    unreadableCaseIds.push(...page.unreadableCaseIds);
    appliedQuery = page.appliedQuery;
    cursor = page.nextCursor;
    pagesRead += 1;
  } while (cursor !== undefined && pagesRead < MAX_LEDGER_PAGES);

  return { rows, unreadableCaseIds, truncated: cursor !== undefined, appliedQuery };
}

/**
 * `listPartners` narrows the server's `{ partners, unreadablePartnerIds }`
 * down to a bare array (unlike every other listing method here, which hands
 * the unreadable-ids field back to the caller) -- the shape the partner
 * picker actually consumes. A partner that could not be read is not silently
 * dropped, though: it is named on the console the same way `adminApi.ts`'s
 * own `fetchListing` names an unreadable visa-platform record.
 */
async function listPartners(idToken: string): Promise<crm.Partner[]> {
  const responsePayload = await apiFetch<unknown>(`${CRM_BASE}/partners`, { idToken });
  const listing = unwrapListingResponse<crm.Partner>(
    responsePayload,
    "partners",
    "unreadablePartnerIds",
  );
  if (listing.unreadableRecordIds.length > 0) {
    console.warn(
      `${listing.unreadableRecordIds.length} partner(s) could not be read and were left out: ${listing.unreadableRecordIds.join(", ")}`,
    );
  }
  return listing.records;
}

export const crmClient = {
  fetchLedgerPage,
  loadLedger,

  getCase(idToken: string, caseId: string): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${caseId}`, { idToken });
  },

  async listCaseEvents(idToken: string, caseId: string): Promise<CrmEventView[]> {
    const { events } = await apiFetch<{ events: CrmEventView[] }>(
      `${CRM_BASE}/cases/${caseId}/events`,
      { idToken },
    );
    return events;
  },

  updateCaseDetails(
    idToken: string,
    caseId: string,
    input: UpdateCaseDetailsBody,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${caseId}`, {
      method: "PUT",
      body: input,
      idToken,
    });
  },

  setCaseStatus(idToken: string, caseId: string, toStatus: crm.CaseStatus): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${caseId}/status`, {
      method: "PUT",
      body: { toStatus },
      idToken,
    });
  },

  setBillingStatus(
    idToken: string,
    caseId: string,
    toBillingStatus: crm.BillingStatus,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${caseId}/billing`, {
      method: "PUT",
      body: { toBillingStatus },
      idToken,
    });
  },

  setCustody(
    idToken: string,
    caseId: string,
    applicantRef: string,
    toCustody: crm.CustodyStatus,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(
      `${CRM_BASE}/cases/${caseId}/applicants/${applicantRef}/custody`,
      { method: "PUT", body: { toCustody }, idToken },
    );
  },

  setOutcome(
    idToken: string,
    caseId: string,
    applicantRef: string,
    toOutcome: crm.ApplicantOutcome,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(
      `${CRM_BASE}/cases/${caseId}/applicants/${applicantRef}/outcome`,
      { method: "PUT", body: { toOutcome }, idToken },
    );
  },

  listPartners,

  fetchReviewSummary(
    idToken: string,
  ): Promise<{ entries: OpenReviewSummaryEntry[]; unreadableReviewItemIds: string[] }> {
    return apiFetch(`${CRM_BASE}/review/summary`, { idToken });
  },

  getReviewItem(idToken: string, reviewItemId: string): Promise<crm.ReviewItem> {
    return apiFetch<crm.ReviewItem>(`${CRM_BASE}/review/${reviewItemId}`, { idToken });
  },

  resolveReviewItem(
    idToken: string,
    reviewItemId: string,
    resolution: { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string },
  ): Promise<crm.ReviewItem> {
    return apiFetch<crm.ReviewItem>(`${CRM_BASE}/review/${reviewItemId}/resolve`, {
      method: "PUT",
      body: resolution,
      idToken,
    });
  },

  runAgentTurn(
    idToken: string,
    body: { userMessage: string; conversation: AgentMessageWire[] },
  ): Promise<AgentTurnResponse> {
    return apiFetch<AgentTurnResponse>(`${CRM_BASE}/agent/turn`, {
      method: "POST",
      body,
      idToken,
    });
  },

  listProposals(
    idToken: string,
  ): Promise<{ proposals: ProposalView[]; unreadableProposalIds: string[] }> {
    return apiFetch(`${CRM_BASE}/agent/proposals`, { idToken });
  },

  approveProposal(
    idToken: string,
    proposalId: string,
    editedInput?: Record<string, unknown>,
  ): Promise<ApprovalResult> {
    return apiFetch<ApprovalResult>(`${CRM_BASE}/agent/proposals/${proposalId}/approve`, {
      method: "PUT",
      body: { editedInput },
      idToken,
    });
  },

  discardProposal(idToken: string, proposalId: string, reason: string): Promise<ProposalView> {
    return apiFetch<ProposalView>(`${CRM_BASE}/agent/proposals/${proposalId}/discard`, {
      method: "PUT",
      body: { reason },
      idToken,
    });
  },

  listMemories(
    idToken: string,
    scope: "ORG" | "PARTNER" | "USER",
    partnerId?: string,
  ): Promise<{ memories: crm.CrmMemory[] }> {
    const queryParams = new URLSearchParams({ scope });
    if (partnerId !== undefined) queryParams.set("partnerId", partnerId);
    return apiFetch(`${CRM_BASE}/agent/memories?${queryParams.toString()}`, { idToken });
  },

  forgetMemory(
    idToken: string,
    memoryKey: string,
    scope: "ORG" | "PARTNER" | "USER",
    partnerId?: string,
  ): Promise<{ forgotten: boolean }> {
    const queryParams = new URLSearchParams({ scope });
    if (partnerId !== undefined) queryParams.set("partnerId", partnerId);
    return apiFetch(`${CRM_BASE}/agent/memories/${memoryKey}?${queryParams.toString()}`, {
      method: "DELETE",
      idToken,
    });
  },
};
