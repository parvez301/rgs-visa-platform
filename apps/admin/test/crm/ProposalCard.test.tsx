import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../src/lib/adminApi";
import { ProposalCard } from "../../src/crm/agent/ProposalCard";
import type { ProposalView } from "../../src/crm/api/crmClient";

/**
 * One staged proposal, shaped exactly like `ProposedChange`
 * (services/api/src/agent/approval.ts) as the proposals route returns it.
 *
 * `input` is the WHOLE tool input, because that is what an edited approval has
 * to send back: `applyApprovedChange` re-parses `editedInput` through the
 * tool's own `inputSchema` (approval.ts:475), so a partial patch is a 400, not
 * a merge.
 */
function proposalFor(
  toolName: string,
  summary: ProposalView["summary"],
  proposalId = "prop_1",
): ProposalView {
  return {
    proposalId,
    toolName,
    input: { caseId: "case_1", applicantRef: "A1", custody: "AT_EMBASSY" },
    summary,
    caseId: "case_1",
    proposedBy: "agent@rgs.test",
    proposedAt: "2026-03-04T10:00:00.000Z",
    status: "PENDING",
  };
}

describe("ProposalCard", () => {
  it("plays back the goal and the change before anything is written (Intent Handshake)", () => {
    render(
      <ProposalCard
        proposals={[proposalFor("set_custody", [{ field: "custody", from: "WITH_RGS", to: "AT_EMBASSY" }])]}
      />,
    );
    expect(screen.getByText(/With us/)).toBeInTheDocument();
    expect(screen.getByText(/At embassy/)).toBeInTheDocument();
  });

  it("puts the one purple control in the product on Approve, and nowhere else", () => {
    const { container } = render(<ProposalCard proposals={[proposalFor("set_custody", [])]} />);
    const purpleElements = [...container.querySelectorAll("[class*='crm-primary']")];
    expect(purpleElements).toHaveLength(1);
    expect(purpleElements[0]!.textContent).toMatch(/approve/i);
  });

  it("lets the human edit the proposal before approving it (Generative Momentum)", async () => {
    const approve = vi.fn().mockResolvedValue({});
    render(<ProposalCard proposals={[proposalFor("set_custody", [])]} onApprove={approve} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    await userEvent.selectOptions(screen.getByLabelText(/custody/i), "IN_TRANSIT");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    // editedInput, not a second proposal: the route rebuilds its own audit
    // summary from the edit, and an edited approval is deliberately NOT
    // counted as a confirm-without-edit.
    //
    // The WHOLE input, not `{ custody }` alone, and `custody` rather than the
    // brief's `toCustody`: `set_custody`'s Zod schema (writeTools.ts:306) is
    // `{ caseId, applicantRef, custody }` and `applyApprovedChange` parses
    // `editedInput` through it, so either departure is a 400.
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("prop_1", {
        caseId: "case_1",
        applicantRef: "A1",
        custody: "IN_TRANSIT",
      }),
    );
  });

  it("does not claim an edit when the human opened the editor and changed nothing", async () => {
    // `editedInput === undefined` is what the approve route reads to decide
    // whether this approval counts toward `confirmedWithoutEditCount`
    // (agentApi.ts). Sending the unchanged input back as an "edit" would
    // silently starve the one signal the trust ladder advances on.
    const approve = vi.fn().mockResolvedValue({});
    render(<ProposalCard proposals={[proposalFor("set_custody", [])]} onApprove={approve} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    await userEvent.selectOptions(screen.getByLabelText(/custody/i), "AT_EMBASSY");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("prop_1", undefined));
  });

  it("groups N proposals into one card and approves them with N calls", async () => {
    const approve = vi.fn().mockResolvedValue({});
    render(
      <ProposalCard
        proposals={[proposalFor("set_custody", [], "prop_1"), proposalFor("set_custody", [], "prop_2")]}
        onApprove={approve}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve all 2/i }));

    // The backend has no bulk write tool and spec §6 deliberately does not add
    // one: each case keeps its own PROPOSAL_APPROVED event, which is a better
    // audit trail for a business billing real clients than one record covering
    // twelve.
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
  });

  it("reports a partial failure per item, never as success", async () => {
    const approve = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new ApiRequestError(409, "CONFLICT", "Cannot move custody from RETURNED to AT_EMBASSY"),
      );
    render(
      <ProposalCard
        proposals={[proposalFor("set_custody", [], "prop_1"), proposalFor("set_custody", [], "prop_2")]}
        onApprove={approve}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve all 2/i }));

    expect(await screen.findByText(/1 applied, 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Cannot move custody from RETURNED to AT_EMBASSY/)).toBeInTheDocument();
    // The failed one is still there to retry or discard -- not silently gone.
    expect(screen.getByTestId("proposal-prop_2")).toBeInTheDocument();
  });

  it("offers Discard on every proposal (Escape Hatch)", () => {
    render(
      <ProposalCard
        proposals={[proposalFor("set_custody", [], "prop_1"), proposalFor("set_billing", [], "prop_2")]}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(2);
  });

  it("sends the reason the human typed with a discard", async () => {
    // R61: `reason` is a REQUIRED string on the discard route
    // (agentApi.ts's DiscardProposalBody), so the card cannot send nothing.
    const discard = vi.fn().mockResolvedValue({});
    render(<ProposalCard proposals={[proposalFor("set_custody", [])]} onDiscard={discard} />);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await userEvent.type(screen.getByLabelText(/why/i), "Wrong applicant");
    await userEvent.click(screen.getByRole("button", { name: /confirm discard/i }));

    await waitFor(() => expect(discard).toHaveBeenCalledWith("prop_1", "Wrong applicant"));
  });

  it("falls back to a default reason rather than sending an empty one the route refuses", async () => {
    const discard = vi.fn().mockResolvedValue({});
    render(<ProposalCard proposals={[proposalFor("set_custody", [])]} onDiscard={discard} />);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await userEvent.click(screen.getByRole("button", { name: /confirm discard/i }));

    await waitFor(() =>
      expect(discard).toHaveBeenCalledWith("prop_1", "Discarded from the agent panel"),
    );
  });

  it("offers an undo on an approval the backend can actually reverse", async () => {
    // custody AT_EMBASSY -> WITH_RGS is a legal move (crm.canTransitionCustody),
    // so the applied change has a way back through the case's own REST route.
    const approve = vi.fn().mockResolvedValue({});
    const undoApproval = vi.fn().mockResolvedValue({});
    render(
      <ProposalCard
        proposals={[
          proposalFor("set_custody", [
            { field: "applicants.A1.custody", from: "WITH_RGS", to: "AT_EMBASSY" },
          ]),
        ]}
        onApprove={approve}
        onUndoApproval={undoApproval}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => expect(undoApproval).toHaveBeenCalledTimes(1));
  });

  it("says so, rather than offering a button that cannot work, when there is no way back", async () => {
    // billing UNBILLED -> BILL_SENT has no reverse edge
    // (crm.canTransitionBilling), and there is no un-approve route at all.
    const approve = vi.fn().mockResolvedValue({});
    render(
      <ProposalCard
        proposals={[
          proposalFor("set_billing", [{ field: "billingStatus", from: "UNBILLED", to: "BILL_SENT" }]),
        ]}
        onApprove={approve}
        onUndoApproval={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText(/cannot be undone from here/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });

  it("never renders a raw enum value", () => {
    render(
      <ProposalCard
        proposals={[
          proposalFor("update_case", [
            { field: "entryType", from: "SINGLE", to: "MULTIPLE" },
            { field: "processing", from: "NORMAL", to: "PREMIUM_LOUNGE" },
          ]),
        ]}
      />,
    );
    expect(screen.getByText("Multiple entry")).toBeInTheDocument();
    expect(screen.getByText("Premium lounge")).toBeInTheDocument();
    expect(screen.queryByText("PREMIUM_LOUNGE")).not.toBeInTheDocument();
  });
});
