import { crm } from "@rgs/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { crmClient } from "./crmClient";

/**
 * Query keys are namespaced under "crm" so nothing here can collide with the
 * visa-platform pages sharing this QueryClient.
 */
export const crmQueryKeys = {
  // Sorted on a COPY: `listLedgerRows` already canonicalizes (dedupes and
  // sorts) the same status list server-side (R9), so a client key built from
  // the caller's own order would treat ["NEW","SUBMITTED"] and
  // ["SUBMITTED","NEW"] as two different queries for one identical server
  // response -- harmless on its own, but a later invalidation keyed off the
  // canonical order would then miss the entry built from the other order.
  // `[...statuses].sort()` never touches the array the caller passed in.
  ledger: (statuses: crm.CaseStatus[], partnerId: string | undefined) =>
    ["crm", "ledger", [...statuses].sort().join(","), partnerId ?? ""] as const,
  case: (caseId: string) => ["crm", "case", caseId] as const,
  caseEvents: (caseId: string) => ["crm", "case", caseId, "events"] as const,
  partners: () => ["crm", "partners"] as const,
  reviewSummary: () => ["crm", "review", "summary"] as const,
  reviewGroups: () => ["crm", "review", "groups"] as const,
  reviewItem: (reviewItemId: string) => ["crm", "review", reviewItemId] as const,
  proposals: () => ["crm", "proposals"] as const,
  memories: (scope: string, partnerId: string | undefined) =>
    ["crm", "memories", scope, partnerId ?? ""] as const,
};

export function useLedgerRows(statuses: crm.CaseStatus[], partnerId?: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.ledger(statuses, partnerId),
    queryFn: () => crmClient.loadLedger(idToken!, { statuses, ...(partnerId ? { partnerId } : {}) }),
    enabled: idToken !== null,
    // The ledger is a 1.4 MB read; the app's 30s default would re-fetch it
    // every time a desk agent tabs back. Five minutes, and every mutation
    // invalidates it explicitly, so staleness is never how a change appears.
    staleTime: 5 * 60_000,
  });
}

export function useCase(caseId: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.case(caseId),
    queryFn: () => crmClient.getCase(idToken!, caseId),
    enabled: idToken !== null,
  });
}

export function useCaseEvents(caseId: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.caseEvents(caseId),
    queryFn: () => crmClient.listCaseEvents(idToken!, caseId),
    enabled: idToken !== null,
  });
}

export function usePartners() {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.partners(),
    queryFn: () => crmClient.listPartners(idToken!),
    enabled: idToken !== null,
  });
}

export function useReviewSummary() {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.reviewSummary(),
    queryFn: () => crmClient.fetchReviewSummary(idToken!),
    enabled: idToken !== null,
  });
}

export function useReviewGroups() {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.reviewGroups(),
    queryFn: () => crmClient.listReviewGroups(idToken!),
    enabled: idToken !== null,
  });
}

export function useReviewItem(reviewItemId: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.reviewItem(reviewItemId),
    queryFn: () => crmClient.getReviewItem(idToken!, reviewItemId),
    enabled: idToken !== null,
  });
}

export function useProposals() {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.proposals(),
    queryFn: () => crmClient.listProposals(idToken!),
    enabled: idToken !== null,
  });
}

export function useMemories(scope: "ORG" | "PARTNER" | "USER", partnerId?: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.memories(scope, partnerId),
    queryFn: () => crmClient.listMemories(idToken!, scope, partnerId),
    enabled: idToken !== null,
  });
}
