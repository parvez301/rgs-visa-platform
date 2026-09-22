import type { CrmEventView } from "../api/crmClient";
import {
  BILLING_LABELS,
  CASE_FIELD_LABELS,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  CUSTODY_LABELS,
  DOCUMENT_CHECK_STATE_LABELS,
  MEMORY_AUTHOR_LABELS,
  OUTCOME_LABELS,
  describeEnumValue,
  describeMemoryScope,
  formatInr,
} from "../labels";

/**
 * One timeline row, in words.
 *
 * `isAutoApplied` is not a styling hint bolted onto the copy -- it is the one
 * fact this module exists to keep: the backend goes out of its way to record
 * whether a human approved a change or the trust ladder applied it with nobody
 * looking (`applyApprovedChange` takes the flag explicitly, and the HTTP
 * approve route leaves it at `false` precisely so the two cannot be confused).
 * A timeline that renders them identically throws that away, so the flag
 * travels out of here alongside the words and `Timeline` gives the two entries
 * different shapes as well as different sentences.
 */
export interface CrmEventCopy {
  title: string;
  detail: string;
  isAutoApplied: boolean;
}

/**
 * Every `meta` key this module reads, with the backend line that writes it.
 * A key read here that nothing writes there is a blank on a desk agent's
 * screen, so the list is exhaustive by construction:
 *
 * | Event                     | Keys                                                  | Written at                |
 * |---------------------------|-------------------------------------------------------|---------------------------|
 * | CASE_CREATED              | caseRef, caseType                                     | crm/cases.ts:98           |
 * | CASE_UPDATED              | changedFields (comma-joined)                          | crm/cases.ts:209          |
 * | CASE_STATUS_CHANGED       | fromStatus, toStatus                                  | crm/cases.ts:234, :397    |
 * | CUSTODY_CHANGED           | applicantRef, fromCustody, toCustody                  | crm/cases.ts:273          |
 * | APPLICANT_OUTCOME_CHANGED | applicantRef, fromOutcome, toOutcome                  | crm/cases.ts:321          |
 * | DOCUMENT_CHECKLIST_CHANGED| documentLabel, fromState, toState OR action=stamped | caseDocumentChecklist.ts |
 * | INVOICE_GENERATED         | fileName, totalInr, lineItemCount                   | caseInvoice.ts           |
 * | PARTNER_NOTIFIED          | channel, toAddress, fromStatus, toStatus            | partnerStatusNotify.ts   |
 * | LINE_ITEM_ADDED           | lineItemCode, quantity, amountInr (UNIT), lineTotalInr | crm/lineItems.ts:79       |
 * | MEMORY_REMEMBERED         | scope, memoryKey, createdBy                           | crm/memory.ts:179         |
 * | PROPOSAL_APPROVED         | proposalId, toolName, edited, changed, autoApplied     | agent/approval.ts:546     |
 * | PROPOSAL_DISCARDED        | proposalId, toolName, reason                          | agent/approval.ts:605     |
 */
type EventMeta = CrmEventView["meta"];

function readMetaString(meta: EventMeta, metaKey: string): string | undefined {
  const rawValue = meta[metaKey];
  return typeof rawValue === "string" ? rawValue : undefined;
}

function readMetaNumber(meta: EventMeta, metaKey: string): number | undefined {
  const rawValue = meta[metaKey];
  return typeof rawValue === "number" ? rawValue : undefined;
}

function readMetaBoolean(meta: EventMeta, metaKey: string): boolean | undefined {
  const rawValue = meta[metaKey];
  return typeof rawValue === "boolean" ? rawValue : undefined;
}

function describeTransition(
  meta: EventMeta,
  fromMetaKey: string,
  toMetaKey: string,
  labels: Readonly<Record<string, string>>,
): string {
  const fromLabel = describeEnumValue(readMetaString(meta, fromMetaKey), labels);
  const toLabel = describeEnumValue(readMetaString(meta, toMetaKey), labels);
  return `${fromLabel} → ${toLabel}`;
}

function describeApplicant(meta: EventMeta): string {
  return `Applicant ${readMetaString(meta, "applicantRef") ?? "not recorded"}`;
}

/** "a", "a and b", "a, b and c" -- never a trailing-comma list a human has to parse. */
function joinAsSentenceList(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * `meta` values are scalars only (crmEvents.ts), so `updateCaseDetails` sends
 * its list of changed field names as one comma-joined string. Printing that
 * string back ("appointmentDate,visaType") hands a desk agent the encoding
 * instead of the fact; this undoes the encoding and names the fields.
 */
function describeChangedFields(meta: EventMeta): string {
  const changedFieldNames = (readMetaString(meta, "changedFields") ?? "")
    .split(",")
    .map((changedFieldName) => changedFieldName.trim())
    .filter((changedFieldName) => changedFieldName.length > 0);
  if (changedFieldNames.length === 0) {
    // Unreachable through `updateCaseDetails`, which returns early rather than
    // recording an event that names no change -- but an empty string here
    // would otherwise render as a bare "Changed ".
    return "No changed fields were recorded on this event.";
  }
  const changedFieldPhrases = changedFieldNames.map(
    (changedFieldName) => CASE_FIELD_LABELS[changedFieldName] ?? changedFieldName,
  );
  return `Changed ${joinAsSentenceList(changedFieldPhrases)}`;
}

/**
 * `amountInr` on this event is the UNIT price, matching the stored line's own
 * field, and `lineTotalInr` is what the line actually moved the case total by
 * (lineItems.ts names both explicitly for exactly this reason). Rendering the
 * first as the second is wrong for any quantity above one.
 */
function describeLineItemAdded(meta: EventMeta): string {
  const lineItemCode = readMetaString(meta, "lineItemCode") ?? "An unnamed line item";
  const quantity = readMetaNumber(meta, "quantity");
  const unitPriceInr = readMetaNumber(meta, "amountInr");
  const lineTotalInr = readMetaNumber(meta, "lineTotalInr");

  const detailParts: string[] = [lineItemCode];
  if (quantity !== undefined && unitPriceInr !== undefined) {
    detailParts.push(`${quantity} × ${formatInr(unitPriceInr)}`);
  } else if (unitPriceInr !== undefined) {
    detailParts.push(`${formatInr(unitPriceInr)} each`);
  } else if (quantity !== undefined) {
    detailParts.push(`quantity ${quantity}`);
  }
  if (lineTotalInr !== undefined) {
    detailParts.push(`${formatInr(lineTotalInr)} added to the case total`);
  }
  return detailParts.join(" · ");
}

function describeProposalApproved(event: CrmEventView, isAutoApplied: boolean): string {
  const detailParts: string[] = [readMetaString(event.meta, "toolName") ?? "an unnamed tool"];
  if (isAutoApplied) {
    // Said in the detail as well as the title, because the title is the line a
    // reader skims and this is the sentence they act on.
    detailParts.push("nobody reviewed this diff before it was applied");
  }
  const wasEdited = readMetaBoolean(event.meta, "edited");
  if (wasEdited !== undefined) {
    detailParts.push(wasEdited ? "the input was edited before approving" : "approved as proposed");
  }
  const changedTheCase = readMetaBoolean(event.meta, "changed");
  if (changedTheCase !== undefined) {
    detailParts.push(changedTheCase ? "the case changed" : "nothing on the case changed");
  }
  return detailParts.join(" · ");
}

function describeMemoryRemembered(meta: EventMeta): string {
  const memoryKey = readMetaString(meta, "memoryKey") ?? "an unnamed memory";
  // The stored value is a composite ("PARTNER#<partnerId>"), not one of the
  // three kinds -- `describeMemoryScope` is what splits it (fix round 1, F1).
  const scopeLabel = describeMemoryScope(readMetaString(meta, "scope"));
  const authorLabel = describeEnumValue(readMetaString(meta, "createdBy"), MEMORY_AUTHOR_LABELS);
  return `${memoryKey} · remembered for ${scopeLabel} · taught by ${authorLabel}`;
}

/**
 * What an event this build does not recognise still has to say. `CrmEventType`
 * is widened by backend plans (crmEvents.ts says so in as many words), and a
 * `switch` with no answer for the new member would render an empty row -- an
 * audit surface silently missing an entry, which is worse than an ugly one.
 * The type and whatever `meta` carried are both named, so an operator has
 * something to report.
 */
function describeUnrecognisedEvent(event: CrmEventView): CrmEventCopy {
  const metaPairs = Object.entries(event.meta).map(
    ([metaKey, metaValue]) => `${metaKey}=${String(metaValue)}`,
  );
  return {
    title: `Unrecognised event ${String(event.eventType)}, recorded by ${event.actorEmail}`,
    detail:
      metaPairs.length === 0
        ? "This desk build has no wording for this event type; report the type above."
        : `This desk build has no wording for this event type. It carried: ${metaPairs.join(", ")}`,
    isAutoApplied: false,
  };
}

export function describeCrmEvent(event: CrmEventView): CrmEventCopy {
  const { meta, actorEmail } = event;
  switch (event.eventType) {
    case "CASE_CREATED":
      return {
        title: `Case created by ${actorEmail}`,
        detail: `${readMetaString(meta, "caseRef") ?? "No REF recorded"} · ${describeEnumValue(
          readMetaString(meta, "caseType"),
          CASE_TYPE_LABELS,
        )}`,
        isAutoApplied: false,
      };

    case "CASE_STATUS_CHANGED":
      return {
        title: `Status changed by ${actorEmail}`,
        detail: describeTransition(meta, "fromStatus", "toStatus", CASE_STATUS_LABELS),
        isAutoApplied: false,
      };

    case "CUSTODY_CHANGED":
      return {
        title: `Custody changed by ${actorEmail}`,
        detail: `${describeApplicant(meta)} · ${describeTransition(meta, "fromCustody", "toCustody", CUSTODY_LABELS)}`,
        isAutoApplied: false,
      };

    case "APPLICANT_OUTCOME_CHANGED":
      return {
        title: `Outcome changed by ${actorEmail}`,
        detail: `${describeApplicant(meta)} · ${describeTransition(meta, "fromOutcome", "toOutcome", OUTCOME_LABELS)}`,
        isAutoApplied: false,
      };

    case "BILLING_CHANGED":
      return {
        title: `Billing changed by ${actorEmail}`,
        detail: describeTransition(meta, "fromBillingStatus", "toBillingStatus", BILLING_LABELS),
        isAutoApplied: false,
      };

    case "DOCUMENT_CHECKLIST_CHANGED": {
      const action = readMetaString(meta, "action");
      if (action === "stamped") {
        const documentCount = readMetaNumber(meta, "documentCount");
        return {
          title: `Document checklist loaded by ${actorEmail}`,
          detail:
            documentCount === undefined
              ? "Country checklist stamped onto the case"
              : `${documentCount} document${documentCount === 1 ? "" : "s"} stamped from the country list`,
          isAutoApplied: false,
        };
      }
      return {
        title: `Document mark changed by ${actorEmail}`,
        detail: `${readMetaString(meta, "documentLabel") ?? "Document"} · ${describeTransition(
          meta,
          "fromState",
          "toState",
          DOCUMENT_CHECK_STATE_LABELS,
        )}`,
        isAutoApplied: false,
      };
    }

    case "INVOICE_GENERATED":
      return {
        title: `Invoice downloaded by ${actorEmail}`,
        detail: `${readMetaString(meta, "fileName") ?? "invoice.pdf"} · ${formatInr(
          readMetaNumber(meta, "totalInr") ?? 0,
        )}`,
        isAutoApplied: false,
      };

    case "PARTNER_NOTIFIED":
      return {
        title: `Partner notified by ${actorEmail}`,
        detail: `Email to ${readMetaString(meta, "toAddress") ?? "unknown"} · ${describeTransition(
          meta,
          "fromStatus",
          "toStatus",
          CASE_STATUS_LABELS,
        )}`,
        isAutoApplied: false,
      };

    case "CASE_UPDATED":
      return {
        title: `Case details updated by ${actorEmail}`,
        detail: describeChangedFields(meta),
        isAutoApplied: false,
      };

    case "LINE_ITEM_ADDED":
      return {
        title: `Line item added by ${actorEmail}`,
        detail: describeLineItemAdded(meta),
        isAutoApplied: false,
      };

    case "PROPOSAL_APPROVED": {
      // The trust ladder is the ONLY writer of `autoApplied: true`
      // (agent/loop.ts's `eligibleForAutoApply`, which requires
      // `userPrefs.trustLevel === 2`), so "trust level 2" is an invariant of
      // the flag rather than a number invented for this sentence -- there is
      // no `trustLevel` key in this event's meta to read, and inventing one
      // would render blank.
      const isAutoApplied = readMetaBoolean(meta, "autoApplied") === true;
      return {
        title: isAutoApplied
          ? `Applied automatically (trust level 2) — ${actorEmail} was the actor`
          : `Approved by ${actorEmail}`,
        detail: describeProposalApproved(event, isAutoApplied),
        isAutoApplied,
      };
    }

    case "PROPOSAL_DISCARDED":
      return {
        title: `Proposal discarded by ${actorEmail}`,
        detail: `${readMetaString(meta, "toolName") ?? "an unnamed tool"} · ${
          readMetaString(meta, "reason") ?? "no reason recorded"
        }`,
        isAutoApplied: false,
      };

    case "MEMORY_REMEMBERED":
      return {
        title: `Remembered by ${actorEmail}`,
        detail: describeMemoryRemembered(meta),
        isAutoApplied: false,
      };

    default:
      return describeUnrecognisedEvent(event);
  }
}
