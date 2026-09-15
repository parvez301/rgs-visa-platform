import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeCrmEvent } from "../../src/crm/case/eventCopy";
import { Timeline } from "../../src/crm/case/Timeline";

/**
 * The timeline is the audit surface. Two things it must never flatten, and
 * both have their own test below: a human approval read as identical to a
 * trust-ladder auto-apply, and a scalar-encoded list (`changedFields`) read
 * back as the raw string the encoding produced.
 *
 * `<Timeline>` is a pure component -- it takes events, it does not fetch them
 * -- so nothing here needs a provider, a router or a stubbed `fetch`.
 */
function readEntryTitles(): (string | null)[] {
  return screen
    .getAllByTestId("timeline-entry")
    .map((entryElement) => entryElement.querySelector("[data-testid='timeline-entry-title']")?.textContent ?? null);
}

describe("Timeline", () => {
  it("tells a human-approved change from an auto-applied one", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "PROPOSAL_APPROVED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { autoApplied: false, toolName: "set_custody" }, createdAt: "2026-03-04T10:00:00.000Z" },
          { eventId: "e2", eventType: "PROPOSAL_APPROVED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { autoApplied: true, toolName: "set_custody" }, createdAt: "2026-03-04T11:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/Approved by ops@rgs.test/)).toBeInTheDocument();
    expect(screen.getByText(/Applied automatically/)).toBeInTheDocument();
    // Both halves: the words differ AND the entries are visually distinct.
    const [humanEntry, autoEntry] = screen.getAllByTestId("timeline-entry");
    expect(humanEntry!.className).not.toBe(autoEntry!.className);
  });

  it("reads a comma-joined changedFields list as a sentence", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "CASE_UPDATED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { changedFields: "appointmentDate,visaType" }, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/appointment date and visa type/i)).toBeInTheDocument();
    expect(screen.queryByText("appointmentDate,visaType")).not.toBeInTheDocument();
  });

  it("names an event type it does not recognise instead of rendering a blank row", () => {
    // CrmEventType is widened by backend plans; an unknown type must degrade
    // to something an operator can report, never to an empty line.
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "WATCHDOG_FIRED" as never, caseId: "case_1", actorEmail: "system", meta: {}, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/WATCHDOG_FIRED/)).toBeInTheDocument();
  });

  it("orders oldest first, the order the API returns", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "CASE_CREATED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { caseRef: "RGS-1001", caseType: "VISA" }, createdAt: "2026-03-04T09:00:00.000Z" },
          { eventId: "e2", eventType: "CASE_STATUS_CHANGED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { fromStatus: "NEW", toStatus: "IN_PROGRESS" }, createdAt: "2026-03-04T10:00:00.000Z" },
          { eventId: "e3", eventType: "BILLING_CHANGED", caseId: "case_1", actorEmail: "desk@rgs.test", meta: { fromBillingStatus: "UNBILLED", toBillingStatus: "BILL_SENT" }, createdAt: "2026-03-04T11:00:00.000Z" },
        ]}
      />,
    );

    // `listCaseEvents` queries the case partition on `EVENT#<ts>#<id>`, which
    // DynamoDB returns in ascending sort-key order -- oldest first. The
    // timeline must not reverse that silently: a reader following a chain of
    // causes needs the cause above the effect.
    expect(readEntryTitles()).toEqual([
      "Case created by ops@rgs.test",
      "Status changed by ops@rgs.test",
      "Billing changed by desk@rgs.test",
    ]);
  });

  it("labels the enum values in a status change rather than printing them raw", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "CUSTODY_CHANGED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { applicantRef: "A1", fromCustody: "WITH_RGS", toCustody: "AT_EMBASSY" }, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/With us → At embassy/)).toBeInTheDocument();
    expect(screen.queryByText(/WITH_RGS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AT_EMBASSY/)).not.toBeInTheDocument();
  });

  it("says so when the timeline is empty rather than drawing nothing at all", () => {
    render(<Timeline events={[]} />);

    expect(screen.getByText(/Nothing has happened on this case yet/)).toBeInTheDocument();
  });
});

describe("describeCrmEvent", () => {
  it("flags the auto-applied approval and only the auto-applied approval", () => {
    const humanApproval = describeCrmEvent({
      eventId: "e1",
      eventType: "PROPOSAL_APPROVED",
      caseId: "case_1",
      actorEmail: "ops@rgs.test",
      meta: { autoApplied: false, toolName: "set_custody" },
      createdAt: "2026-03-04T10:00:00.000Z",
    });
    const autoApproval = describeCrmEvent({
      eventId: "e2",
      eventType: "PROPOSAL_APPROVED",
      caseId: "case_1",
      actorEmail: "ops@rgs.test",
      meta: { autoApplied: true, toolName: "set_custody" },
      createdAt: "2026-03-04T11:00:00.000Z",
    });

    expect(humanApproval.isAutoApplied).toBe(false);
    expect(autoApproval.isAutoApplied).toBe(true);
    expect(humanApproval.title).toBe("Approved by ops@rgs.test");
    expect(autoApproval.title).toBe(
      "Applied automatically (trust level 2) — ops@rgs.test was the actor",
    );
  });

  it("reports a line item with its unit price, quantity and what it added to the total", () => {
    // `amountInr` in this event's meta is the UNIT price (lineItems.ts) and
    // `lineTotalInr` is what the line moved the case total by. Reading the
    // first as the second is wrong for any quantity above one.
    const lineItemAdded = describeCrmEvent({
      eventId: "e1",
      eventType: "LINE_ITEM_ADDED",
      caseId: "case_1",
      actorEmail: "ops@rgs.test",
      meta: { lineItemCode: "VISA_FEE", quantity: 2, amountInr: 5000, lineTotalInr: 10000 },
      createdAt: "2026-03-04T10:00:00.000Z",
    });

    expect(lineItemAdded.detail).toBe("VISA_FEE · 2 × ₹5,000 · ₹10,000 added to the case total");
  });
});
