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

/**
 * What the server actually sends back (crmApi.ts:251): `partnerId` and
 * `statuses` are mutually exclusive, not both-optional. In partner mode the
 * status filter is not enforced server-side, so `statuses` is omitted
 * entirely rather than echoed back as a synthesised list; in status mode
 * there is no partner scoping, so `partnerId` is omitted. A both-optional
 * shape would compile and would let a consumer write `appliedQuery.statuses!`
 * and be wrong at runtime the moment that consumer runs in partner mode --
 * the union instead forces every consumer to narrow before it can read
 * either field.
 */
export type LedgerAppliedQuery =
  | { statuses: crm.CaseStatus[]; limit: number }
  | { partnerId: string; limit: number };

export interface LedgerPageResponse {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  nextCursor?: string;
  appliedQuery: LedgerAppliedQuery;
}

export interface LedgerLoad {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  /** True when the page cap stopped the walk before the cursor ran out. */
  truncated: boolean;
  appliedQuery: LedgerAppliedQuery;
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
  | "MEMORY_REMEMBERED"
  | "DOCUMENT_CHECKLIST_CHANGED";

export interface CrmEventView {
  eventId: string;
  eventType: CrmEventType;
  caseId: string;
  actorEmail: string;
  meta: Record<string, string | number | boolean>;
  createdAt: string;
}

/**
 * The plain fields `PUT /cases/{caseId}` accepts (crmApi.ts's own
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
  remarks?: string;
}

/** Mirrors `OpenReviewSummaryEntry` (services/api/src/domain/crm/reviewQueue.ts). */
export interface OpenReviewSummaryEntry {
  caseRef: string;
  /** Every reason with an open item on the case, badged or not; the Ledger's issue filter reads this. */
  openReasons: crm.ReviewReason[];
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

/** Body of POST /cases -- mirrors `CreateCaseBody` in @rgs/shared. */
export interface CreateCaseInput {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  receivedDate: string;
  expectedCollectionDate?: string;
  remarks?: string;
  applicants: Array<{ applicantRef: string; travellerId: string; passportNumber?: string }>;
}

export interface CreatePartnerInput {
  canonicalName: string;
}

export interface UpsertTravellerInput {
  fullName: string;
  passportNumber?: string;
}

/** One raw-value group of the open review queue (server: reviewGroups.ts). */
export interface ReviewGroup {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  itemCount: number;
  proposedValue?: string;
  sampleCaseRefs: string[];
}

export interface ResolveReviewGroupInput {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  reviewStatus: "APPLIED" | "DISMISSED";
  resolvedValue?: string;
  limit?: number;
}

export interface ReviewGroupResolution {
  matchedCount: number;
  resolvedCount: number;
  appliedCount: number;
  remainingCount: number;
  failures: Array<{ reviewItemId: string; caseRef: string; message: string }>;
}

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
  // Overwritten by the first page's own `appliedQuery` below on every call --
  // the loop always runs at least once -- so this placeholder only has to
  // satisfy the union's shape, not describe the actual request.
  let appliedQuery: LedgerAppliedQuery = { statuses: params.statuses ?? [], limit: 0 };
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

/**
 * R80: every interpolated PATH SEGMENT below goes through
 * `encodeURIComponent`.
 *
 * Most of these are server-generated ids and were safe by luck. One is not:
 * `forgetMemory`'s `memoryKey` is free text -- `CrmMemorySchema` declares it
 * `z.string().min(1)` and the agent's own `remember` tool authors it -- so a
 * key containing "/" adds a path segment and `Router.match`'s segment-count
 * guard drops the route, and a "#" truncates the URL at the fragment. Either
 * way the Forget button 404s in deployed API Gateway and never in a test,
 * where every fixture key is `billing_cutoff`. Encoding all of them rather
 * than the one that is provably unsafe is the cheaper rule to keep: the next
 * free-text segment does not have to be noticed.
 */
export const crmClient = {
  fetchLedgerPage,
  loadLedger,

  createCase(idToken: string, input: CreateCaseInput): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases`, { method: "POST", body: input, idToken });
  },

  createPartner(idToken: string, input: CreatePartnerInput): Promise<crm.Partner> {
    return apiFetch<crm.Partner>(`${CRM_BASE}/partners`, { method: "POST", body: input, idToken });
  },

  upsertTraveller(idToken: string, input: UpsertTravellerInput): Promise<crm.CrmTraveller> {
    return apiFetch<crm.CrmTraveller>(`${CRM_BASE}/travellers`, { method: "POST", body: input, idToken });
  },

  /** `undefined` when no traveller holds that passport; the server says 404. */
  async findTravellerByPassport(idToken: string, passportNumber: string): Promise<crm.CrmTraveller | undefined> {
    try {
      return await apiFetch<crm.CrmTraveller>(
        `${CRM_BASE}/travellers/by-passport/${encodeURIComponent(passportNumber)}`,
        { idToken },
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.statusCode === 404) return undefined;
      throw error;
    }
  },

  getCase(idToken: string, caseId: string): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}`, { idToken });
  },

  async listCaseEvents(idToken: string, caseId: string): Promise<CrmEventView[]> {
    const { events } = await apiFetch<{ events: CrmEventView[] }>(
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/events`,
      { idToken },
    );
    return events;
  },

  updateCaseDetails(
    idToken: string,
    caseId: string,
    input: UpdateCaseDetailsBody,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}`, {
      method: "PUT",
      body: input,
      idToken,
    });
  },

  setCaseStatus(idToken: string, caseId: string, toStatus: crm.CaseStatus): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}/status`, {
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
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}/billing`, {
      method: "PUT",
      body: { toBillingStatus },
      idToken,
    });
  },

  ensureDocumentChecklist(idToken: string, caseId: string): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/document-checklist/ensure`,
      { method: "POST", idToken },
    );
  },

  setDocumentCheckState(
    idToken: string,
    caseId: string,
    label: string,
    state: crm.DocumentCheckState,
  ): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}/document-checklist`, {
      method: "PUT",
      body: { label, state },
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
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/applicants/${encodeURIComponent(applicantRef)}/custody`,
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
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/applicants/${encodeURIComponent(applicantRef)}/outcome`,
      { method: "PUT", body: { toOutcome }, idToken },
    );
  },

  listPartners,

  fetchReviewSummary(
    idToken: string,
  ): Promise<{ entries: OpenReviewSummaryEntry[]; unreadableReviewItemIds: string[] }> {
    return apiFetch(`${CRM_BASE}/review/summary`, { idToken });
  },

  listReviewGroups(idToken: string): Promise<{ groups: ReviewGroup[]; unreadableReviewItemIds: string[] }> {
    return apiFetch(`${CRM_BASE}/review/groups`, { idToken });
  },

  resolveReviewGroup(idToken: string, input: ResolveReviewGroupInput): Promise<ReviewGroupResolution> {
    return apiFetch<ReviewGroupResolution>(`${CRM_BASE}/review/groups/resolve`, {
      method: "POST",
      body: input,
      idToken,
    });
  },

  getReviewItem(idToken: string, reviewItemId: string): Promise<crm.ReviewItem> {
    return apiFetch<crm.ReviewItem>(`${CRM_BASE}/review/${encodeURIComponent(reviewItemId)}`, { idToken });
  },

  resolveReviewItem(
    idToken: string,
    reviewItemId: string,
    resolution: { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string },
  ): Promise<crm.ReviewItem> {
    return apiFetch<crm.ReviewItem>(`${CRM_BASE}/review/${encodeURIComponent(reviewItemId)}/resolve`, {
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
    return apiFetch<ApprovalResult>(`${CRM_BASE}/agent/proposals/${encodeURIComponent(proposalId)}/approve`, {
      method: "PUT",
      body: { editedInput },
      idToken,
    });
  },

  discardProposal(idToken: string, proposalId: string, reason: string): Promise<ProposalView> {
    return apiFetch<ProposalView>(`${CRM_BASE}/agent/proposals/${encodeURIComponent(proposalId)}/discard`, {
      method: "PUT",
      body: { reason },
      idToken,
    });
  },

  listMemories(
    idToken: string,
    scope: "ORG" | "PARTNER" | "USER",
    partnerId?: string,
  ): Promise<{ memories: crm.CrmMemory[]; unreadableMemoryKeys: string[] }> {
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
    return apiFetch(`${CRM_BASE}/agent/memories/${encodeURIComponent(memoryKey)}?${queryParams.toString()}`, {
      method: "DELETE",
      idToken,
    });
  },
};
