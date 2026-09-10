/**
 * A domain mutation a write tool wants to make, staged for a human to approve
 * before it happens. Every write tool's `execute` (registry.ts) builds and
 * returns one of these and touches the table not at all; `apply` is the half
 * that actually calls the domain mutator, and the approval gate is its only
 * caller. That gate -- `stageProposal`, `listPendingProposals`,
 * `applyApprovedChange`, `discardProposal` -- is a later task and does not
 * live in this file yet.
 */
export interface ProposedChange {
  proposalId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable diff for the UI card: field, from, to. */
  summary: { field: string; from: string; to: string }[];
  caseId?: string;
  proposedBy: string; // actor email
  proposedAt: string;
  status: "PENDING" | "APPROVED" | "DISCARDED";
}
