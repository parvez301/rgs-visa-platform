import type { NoticeCategory, NoticeSeverity } from "@rgs/shared";

const CATEGORY_LABELS: Record<NoticeCategory, string> = {
  RULE_CHANGE: "Rule change",
  FEE_UPDATE: "Fee update",
  GENERAL: "General",
  ALERT: "Alert",
};

const SEVERITY_CLASSES: Record<NoticeSeverity, string> = {
  INFO: "bg-sky-100 text-sky-900",
  IMPORTANT: "bg-amber-100 text-amber-900",
  URGENT: "bg-rgs-red/10 text-rgs-red",
};

export function NoticeBadge({
  category,
  severity,
}: {
  category: NoticeCategory;
  severity: NoticeSeverity;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_CLASSES[severity]}`}
      >
        {severity}
      </span>
      <span className="rounded-full border border-line px-2.5 py-0.5 text-[10px] font-semibold text-ink-soft">
        {CATEGORY_LABELS[category]}
      </span>
    </span>
  );
}
