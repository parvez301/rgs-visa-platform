import type { MappedRow, PendingReviewItem } from "./mapRow";

export interface ResidueResolution {
  fieldName: string;
  proposedValue: string;
  /** 0..1. Spec §9: >= 0.9 auto-applies, below goes to review. */
  confidence: number;
}

/**
 * Spec §9 pass 2. Plan 4's agent layer supplies the LLM-backed
 * implementation; this plan ships only the seam so the importer's wiring is
 * already correct when it arrives. Deliberately no model and no provider
 * dependency here.
 */
export interface ResidueResolver {
  resolve(row: MappedRow, pending: PendingReviewItem[]): Promise<ResidueResolution[]>;
}

export const passthroughResidueResolver: ResidueResolver = {
  async resolve(): Promise<ResidueResolution[]> {
    return [];
  },
};
