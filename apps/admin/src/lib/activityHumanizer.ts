import type {
  ActivityEvent,
  ActivityEventType,
  DocType,
  User,
} from "@rgs/shared";
import { DOC_LABELS, STATUS_LABELS } from "./labels";

export interface HumanizerContext {
  countryNameByCode: Map<string, string>;
  userNameById: Map<string, User>;
}

export interface HumanizedEvent {
  icon: string;
  text: string;
}

function shortId(value: string): string {
  return value.slice(0, 10);
}

function resolveActorName(
  activityEvent: ActivityEvent,
  humanizerContext: HumanizerContext,
): string {
  const profile = humanizerContext.userNameById.get(activityEvent.userId);
  return (
    profile?.fullName ??
    activityEvent.actorEmail ??
    shortId(activityEvent.userId)
  );
}

function countryLabel(
  countryCode: unknown,
  humanizerContext: HumanizerContext,
): string {
  if (typeof countryCode !== "string") return "a";
  return humanizerContext.countryNameByCode.get(countryCode) ?? countryCode;
}

function docLabel(docType: unknown): string {
  if (typeof docType !== "string") return "a document";
  return DOC_LABELS[docType as DocType] ?? docType;
}

const EVENT_ICONS: Record<ActivityEventType, string> = {
  SIGNED_UP: "👤",
  APPLICATION_STARTED: "📝",
  STEP_COMPLETED: "✅",
  DOC_UPLOADED: "📎",
  DOC_REVIEWED: "🔍",
  SUBMITTED: "📨",
  STATUS_CHANGED: "🔄",
  PAYMENT_REQUESTED: "💳",
  PAYMENT_MARKED_PAID: "💰",
  LEAD_CREATED: "📬",
  CONFIG_CHANGED: "⚙️",
  NOTICE_PUBLISHED: "📢",
};

export function eventToSentence(
  activityEvent: ActivityEvent,
  humanizerContext: HumanizerContext,
): HumanizedEvent {
  const actorName = resolveActorName(activityEvent, humanizerContext);
  const roleTag =
    activityEvent.actorRole === undefined
      ? ""
      : ` [${activityEvent.actorRole}]`;
  const icon = EVENT_ICONS[activityEvent.eventType] ?? "•";
  const meta = activityEvent.meta;

  let text: string;
  switch (activityEvent.eventType) {
    case "SIGNED_UP":
      text = `${actorName} created an account`;
      break;
    case "APPLICATION_STARTED":
      text = `started a ${countryLabel(meta["countryCode"], humanizerContext)} application`;
      break;
    case "STEP_COMPLETED":
      text = `completed the ${String(meta["step"] ?? "wizard")} step`;
      break;
    case "DOC_UPLOADED": {
      const travellerNumber =
        typeof meta["travellerIndex"] === "number"
          ? meta["travellerIndex"] + 1
          : "?";
      text = `uploaded ${docLabel(meta["docType"])} (traveller ${travellerNumber})`;
      break;
    }
    case "DOC_REVIEWED": {
      const travellerNumber =
        typeof meta["travellerIndex"] === "number"
          ? meta["travellerIndex"] + 1
          : "?";
      text = `admin ${String(meta["decision"] ?? "reviewed").toLowerCase()} ${docLabel(meta["docType"])} (traveller ${travellerNumber})`;
      break;
    }
    case "SUBMITTED":
      text = `submitted the ${countryLabel(meta["countryCode"], humanizerContext)} application`;
      break;
    case "STATUS_CHANGED": {
      const fromStatus =
        typeof meta["fromStatus"] === "string"
          ? (STATUS_LABELS[meta["fromStatus"] as keyof typeof STATUS_LABELS] ??
            meta["fromStatus"])
          : "?";
      const toStatus =
        typeof meta["toStatus"] === "string"
          ? (STATUS_LABELS[meta["toStatus"] as keyof typeof STATUS_LABELS] ??
            meta["toStatus"])
          : "?";
      text = `status: ${fromStatus} → ${toStatus} (by admin)`;
      break;
    }
    case "PAYMENT_REQUESTED":
      text = "admin requested payment";
      break;
    case "PAYMENT_MARKED_PAID":
      text = "admin marked payment received";
      break;
    case "LEAD_CREATED":
      text = `new website enquiry: ${String(meta["topic"] ?? "general")}`;
      break;
    case "CONFIG_CHANGED":
      text = `admin updated ${countryLabel(meta["countryCode"], humanizerContext)} config`;
      break;
    case "NOTICE_PUBLISHED":
      text = `admin published notice: ${String(meta["title"] ?? "untitled")}`;
      break;
    default:
      text = activityEvent.eventType;
  }

  return { icon, text: `${text}${roleTag}` };
}
