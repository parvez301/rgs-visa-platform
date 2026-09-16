/**
 * The CRM's control vocabulary, in one place so every screen agrees on what a
 * primary action, a secondary action, a filter pill and an input look like.
 * The values are the admin's own (`styles.css` tokens; the Queue page's pills
 * and chips), so the desk reads as the same product as the rest of the admin.
 *
 * Primary is RGS red and is used for the action a screen exists to complete:
 * Approve on a proposal, Send to the agent, Create case, Record a review
 * decision. Everything else is secondary.
 */
export const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-rgs-red px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-rgs-red-deep disabled:cursor-not-allowed disabled:opacity-50";

export const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-full border border-line bg-paper px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50";

/** A small secondary control that sits inside dense content (a card row, a popover). */
export const COMPACT_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full border border-line bg-paper px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50";

export const COMPACT_PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full bg-rgs-red px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-rgs-red-deep disabled:cursor-not-allowed disabled:opacity-50";

/** Toggle pills: the Queue page's status tabs. */
export const PILL_ON_CLASS = "rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-paper transition-colors";
export const PILL_OFF_CLASS =
  "rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-ink/30";

export const INPUT_CLASS =
  "rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-soft/70 focus:border-ink/40 disabled:bg-mist disabled:text-ink-soft";

/** The small caps label the admin already uses over data (`.mrz` in styles.css). */
export const FIELD_LABEL_CLASS = "mrz text-[10px] text-ink-soft";

export const CARD_CLASS = "rounded-2xl border border-line bg-paper";
