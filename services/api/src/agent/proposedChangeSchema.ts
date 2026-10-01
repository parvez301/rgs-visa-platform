import { z } from "zod";

/**
 * The write-path/read-path schema for a stored proposal. `ProposedChange`
 * (approval.ts) stays a plain interface -- the type every write tool's
 * `execute` returns -- and this is the separate validator a *stored* row is
 * parsed back through, the same split `reviewQueue.ts` uses between
 * `crm.ReviewItem` and `crm.ReviewItemSchema`.
 *
 * Lives in its own module so both storage paths (Dynamo in approval.ts,
 * Postgres in domain/crm/proposalsPostgres.ts) share one definition without
 * an import cycle.
 */
export const ProposedChangeSchema = z.object({
  proposalId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
  summary: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
  caseId: z.string().optional(),
  proposedBy: z.string().min(1),
  proposedAt: z.string(),
  status: z.enum(["PENDING", "APPROVED", "DISCARDED"]),
  // .min(1), not a bare .optional(): absent stays legal (a PENDING proposal
  // has no decidedBy yet), but an empty string does not -- it is the
  // backstop against an admin token with no email claim approving or
  // discarding a proposal as "" (task-11-fix-1-review.md M3). The route
  // layer (agentApi.ts's requireAdminEmail) is where this is actually
  // prevented; this is what refuses it a second time, on read, if any call
  // site ever forgets.
  decidedBy: z.string().min(1).optional(),
  decidedAt: z.string().optional(),
  discardReason: z.string().optional(),
});
