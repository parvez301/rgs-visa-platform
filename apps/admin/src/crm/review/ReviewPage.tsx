import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { crm } from "@rgs/shared";
import { adminApi } from "../../lib/adminApi";
import { useAuth } from "../../lib/auth";
import { AgentPanel } from "../agent/AgentPanel";
import { crmClient, type ReviewGroup, type ReviewGroupResolution } from "../api/crmClient";
import { useReviewGroups, usePartners } from "../api/hooks";
import { LEDGER_CACHE_KEY_PREFIX } from "../api/mutations";
import {
  CARD_CLASS,
  COMPACT_BUTTON_CLASS,
  COMPACT_PRIMARY_BUTTON_CLASS,
  INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";
import { CrmLayout } from "../CrmLayout";
import { CASE_STATUS_LABELS, ENTRY_TYPE_LABELS, REVIEW_REASON_LABELS, VISA_TYPE_LABELS } from "../labels";

/** Items closed per request; the server caps at 200 and the Lambda at 15s. */
const RESOLVE_CHUNK_SIZE = 50;

/** The order reasons are listed in: what needs a decision first. */
const REASON_ORDER: readonly crm.ReviewReason[] = [
  "DUPLICATE_REF",
  "UNMAPPED_PARTNER",
  "UNMAPPED_COUNTRY",
  "UNPARSEABLE_DATE",
  "UNMAPPED_STATUS",
  "UNMAPPED_VISA_TYPE",
  "UNMAPPED_ENTRIES",
  "COLUMN_SHIFT_JUNK",
  "UNCONFIRMED_PAYMENT",
  "UNREADABLE_STORED_CASE",
  "MISSING_REQUIRED_FIELD",
  "SUSPECT_PHONE",
  "PROPOSED_GROUP",
];

const REASON_GUIDANCE: Record<crm.ReviewReason, string> = {
  UNMAPPED_PARTNER: "Pick the partner once. Every case whose sheet row said this moves to that partner.",
  UNMAPPED_COUNTRY: "Type the two-letter country code once. Every case whose sheet row said this gets it.",
  UNPARSEABLE_DATE: "Read the sheet's text as a date once. Every case whose row said this gets that date.",
  UNMAPPED_STATUS: "Pick the status the sheet meant. Every case whose row said this moves to it.",
  UNMAPPED_VISA_TYPE: "Pick the visa type the sheet meant. Every VISA case whose row said this gets it.",
  UNMAPPED_ENTRIES: "Pick the entry type the sheet meant. Every case whose row said this gets it.",
  DUPLICATE_REF: "Two rows share one REF. These are worked one by one from the Ledger marker, where both rows are visible.",
  COLUMN_SHIFT_JUNK: "Text that landed in the wrong column. Nothing to write back; dismiss once the row has been checked.",
  UNCONFIRMED_PAYMENT: "The sheet says paid but nothing confirms it. Settle it on the case's billing status, then dismiss here.",
  UNREADABLE_STORED_CASE: "A stored case could not be read back. Repair or delete the record, then dismiss.",
  MISSING_REQUIRED_FIELD: "The sheet had no usable value. Nothing to write back; fill it in on the case when it comes up.",
  SUSPECT_PHONE: "A phone number the importer doubted. Nothing to write back; dismiss to clear the note.",
  PROPOSED_GROUP: "Adjacent rows that share partner, country and date. A guess, not an error; dismiss when they are separate cases.",
};

function groupKey(group: ReviewGroup): string {
  return `${group.reason}\u0000${group.fieldName}\u0000${group.rawValue}`;
}

export function ReviewPage() {
  const groupsQuery = useReviewGroups();
  const groups = groupsQuery.data?.groups ?? [];

  const countByReason = useMemo(() => {
    const counts = new Map<crm.ReviewReason, number>();
    for (const group of groups) counts.set(group.reason, (counts.get(group.reason) ?? 0) + group.itemCount);
    return counts;
  }, [groups]);
  const openItemTotal = groups.reduce((sum, group) => sum + group.itemCount, 0);
  const reasonsWithItems = REASON_ORDER.filter((reason) => (countByReason.get(reason) ?? 0) > 0);

  const [chosenReason, setChosenReason] = useState<crm.ReviewReason | null>(null);
  const selectedReason = chosenReason ?? reasonsWithItems[0] ?? null;
  const visibleGroups = groups.filter((group) => group.reason === selectedReason);

  return (
    <CrmLayout agentPanel={<AgentPanel selectedCaseIds={[]} />}>
      <div className="flex h-full flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Review queue</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              {groupsQuery.isLoading
                ? "Counting open items…"
                : `${openItemTotal.toLocaleString()} open items, ${groups.length.toLocaleString()} distinct values`}
            </p>
          </div>
          <Link to="/crm" className={SECONDARY_BUTTON_CLASS}>
            Back to the ledger
          </Link>
        </div>

        {groupsQuery.isError && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
            The review queue could not be loaded: {String(groupsQuery.error)}
          </p>
        )}

        <div className="grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: "260px minmax(0, 1fr)" }}>
          <nav aria-label="Review reasons" className={`${CARD_CLASS} flex flex-col gap-1 overflow-y-auto p-2`}>
            {reasonsWithItems.map((reason) => {
              const isSelected = reason === selectedReason;
              return (
                <button
                  key={reason}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setChosenReason(reason)}
                  className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    isSelected ? "bg-ink text-paper" : "text-ink hover:bg-mist"
                  }`}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{REVIEW_REASON_LABELS[reason]}</span>
                    {!crm.isLedgerMarkerReason(reason) && (
                      <span className={`text-[11px] ${isSelected ? "text-paper/70" : "text-ink-soft"}`}>
                        Not shown on the Ledger
                      </span>
                    )}
                  </span>
                  <span className="mrz text-xs">{(countByReason.get(reason) ?? 0).toLocaleString()}</span>
                </button>
              );
            })}
            {!groupsQuery.isLoading && reasonsWithItems.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-soft">Nothing left to review.</p>
            )}
          </nav>

          <section className={`${CARD_CLASS} flex min-h-0 flex-col overflow-hidden`}>
            {selectedReason !== null && (
              <>
                <header className="border-b border-line px-5 py-4">
                  <h2 className="text-base font-semibold text-ink">{REVIEW_REASON_LABELS[selectedReason]}</h2>
                  <p className="mt-0.5 text-sm text-ink-soft">{REASON_GUIDANCE[selectedReason]}</p>
                </header>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 bg-mist">
                      <tr className="mrz border-b border-line text-[10px] text-ink-soft">
                        <th className="px-5 py-2.5 font-medium">Sheet said</th>
                        <th className="px-3 py-2.5 font-medium">Cases</th>
                        <th className="px-3 py-2.5 font-medium">Sample REFs</th>
                        <th className="px-5 py-2.5 font-medium">Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGroups.map((group) => (
                        <ReviewGroupRow key={groupKey(group)} group={group} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </CrmLayout>
  );
}

type RowPhase =
  | { kind: "idle" }
  | { kind: "confirming"; action: "APPLIED" | "DISMISSED" }
  | { kind: "running"; action: "APPLIED" | "DISMISSED"; doneCount: number; totalCount: number }
  | { kind: "finished"; action: "APPLIED" | "DISMISSED"; resolvedCount: number; failures: ReviewGroupResolution["failures"] }
  | { kind: "failed"; message: string };

function ReviewGroupRow({ group }: { group: ReviewGroup }) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const isAppliable = crm.isAppliableReviewReason(group.reason);
  const [resolvedValue, setResolvedValue] = useState(group.proposedValue ?? "");
  const [phase, setPhase] = useState<RowPhase>({ kind: "idle" });

  async function run(action: "APPLIED" | "DISMISSED") {
    setPhase({ kind: "running", action, doneCount: 0, totalCount: group.itemCount });
    const failures: ReviewGroupResolution["failures"] = [];
    let resolvedCount = 0;
    try {
      // Loop until the group is empty or a call makes no progress: a case the
      // server could not rewrite stays OPEN and would otherwise match forever.
      for (;;) {
        const chunk = await crmClient.resolveReviewGroup(idToken!, {
          reason: group.reason,
          fieldName: group.fieldName,
          rawValue: group.rawValue,
          reviewStatus: action,
          ...(action === "APPLIED" ? { resolvedValue } : {}),
          limit: RESOLVE_CHUNK_SIZE,
        });
        resolvedCount += chunk.resolvedCount;
        failures.push(...chunk.failures);
        setPhase({ kind: "running", action, doneCount: resolvedCount, totalCount: chunk.matchedCount + resolvedCount - chunk.resolvedCount });
        if (chunk.remainingCount === 0 || chunk.resolvedCount === 0) break;
      }
      setPhase({ kind: "finished", action, resolvedCount, failures });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["crm", "review"] });
      void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
      void queryClient.invalidateQueries({ queryKey: ["crm", "case"] });
    }
  }

  const caseWord = group.itemCount === 1 ? "case" : "cases";

  return (
    <tr className="border-b border-line align-top last:border-b-0">
      <td className="px-5 py-3">
        <span className="font-medium text-ink">{group.rawValue === "" ? "(blank)" : group.rawValue}</span>
        <span className="block text-xs text-ink-soft">Column “{group.fieldName}”</span>
      </td>
      <td className="mrz px-3 py-3 text-xs text-ink">{group.itemCount.toLocaleString()}</td>
      <td className="mrz px-3 py-3 text-xs text-ink-soft">{group.sampleCaseRefs.join("  ")}</td>
      <td className="px-5 py-3">
        {phase.kind === "running" ? (
          <p role="status" className="text-sm text-ink-soft">
            {phase.action === "APPLIED" ? "Applying" : "Dismissing"}… {phase.doneCount.toLocaleString()} of{" "}
            {phase.totalCount.toLocaleString()}
          </p>
        ) : phase.kind === "finished" ? (
          <div role="status" className="text-sm">
            <p className="text-ink">
              {phase.action === "APPLIED" ? "Applied to" : "Dismissed"} {phase.resolvedCount.toLocaleString()}{" "}
              {phase.resolvedCount === 1 ? "case" : "cases"}.
            </p>
            {phase.failures.length > 0 && (
              <ul className="mt-1 text-rose-900">
                {phase.failures.map((failure) => (
                  <li key={failure.reviewItemId}>
                    <span className="mrz text-xs">{failure.caseRef}</span> stays open: {failure.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : phase.kind === "failed" ? (
          <div className="text-sm">
            <p role="alert" className="text-rose-900">
              Nothing was changed: {phase.message}
            </p>
            <button type="button" onClick={() => setPhase({ kind: "idle" })} className={`${COMPACT_BUTTON_CLASS} mt-2`}>
              Try again
            </button>
          </div>
        ) : phase.kind === "confirming" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink">
              {phase.action === "APPLIED"
                ? `Rewrite ${group.itemCount.toLocaleString()} ${caseWord}?`
                : `Dismiss ${group.itemCount.toLocaleString()} ${group.itemCount === 1 ? "item" : "items"}?`}
            </span>
            <button type="button" onClick={() => void run(phase.action)} className={COMPACT_PRIMARY_BUTTON_CLASS}>
              Yes, {phase.action === "APPLIED" ? "apply" : "dismiss"}
            </button>
            <button type="button" onClick={() => setPhase({ kind: "idle" })} className={COMPACT_BUTTON_CLASS}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {isAppliable && (
              <>
                <ResolvedValueControl group={group} value={resolvedValue} onChange={setResolvedValue} />
                <button
                  type="button"
                  disabled={resolvedValue === ""}
                  onClick={() => setPhase({ kind: "confirming", action: "APPLIED" })}
                  className={COMPACT_PRIMARY_BUTTON_CLASS}
                >
                  Apply to {group.itemCount.toLocaleString()} {caseWord}
                </button>
              </>
            )}
            {group.reason !== "DUPLICATE_REF" && (
              <button
                type="button"
                onClick={() => setPhase({ kind: "confirming", action: "DISMISSED" })}
                className={COMPACT_BUTTON_CLASS}
              >
                Dismiss {group.itemCount.toLocaleString()}
              </button>
            )}
            {group.reason === "DUPLICATE_REF" && (
              <Link to="/crm" className="text-sm font-medium text-rgs-red-deep hover:underline">
                Open on the ledger
              </Link>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

const CONTROL_CLASS = `${INPUT_CLASS} h-8 py-0 text-xs`;

function ResolvedValueControl({
  group,
  value,
  onChange,
}: {
  group: ReviewGroup;
  value: string;
  onChange(nextValue: string): void;
}) {
  const label = `Value for ${group.rawValue === "" ? "(blank)" : group.rawValue}`;
  switch (group.reason) {
    case "UNMAPPED_PARTNER":
      return <PartnerSelect label={label} value={value} onChange={onChange} />;
    case "UNMAPPED_COUNTRY":
      return <CountryInput label={label} value={value} onChange={onChange} />;
    case "UNPARSEABLE_DATE":
      return (
        <input
          type="date"
          aria-label={label}
          value={value}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          className={CONTROL_CLASS}
        />
      );
    case "UNMAPPED_STATUS":
      return (
        <EnumSelect label={label} value={value} onChange={onChange} options={crm.CASE_STATUSES} labels={CASE_STATUS_LABELS} />
      );
    case "UNMAPPED_VISA_TYPE":
      return (
        <EnumSelect label={label} value={value} onChange={onChange} options={crm.VISA_TYPES} labels={VISA_TYPE_LABELS} />
      );
    case "UNMAPPED_ENTRIES":
      return (
        <EnumSelect label={label} value={value} onChange={onChange} options={crm.ENTRY_TYPES} labels={ENTRY_TYPE_LABELS} />
      );
    default:
      return null;
  }
}

function EnumSelect<OptionValue extends string>({
  label,
  value,
  onChange,
  options,
  labels,
}: {
  label: string;
  value: string;
  onChange(nextValue: string): void;
  options: readonly OptionValue[];
  labels: Record<OptionValue, string>;
}) {
  return (
    <select aria-label={label} value={value} onChange={(changeEvent) => onChange(changeEvent.target.value)} className={CONTROL_CLASS}>
      <option value="">Choose…</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {labels[option]}
        </option>
      ))}
    </select>
  );
}

function PartnerSelect({ label, value, onChange }: { label: string; value: string; onChange(nextValue: string): void }) {
  const partnersQuery = usePartners();
  const partners = [...(partnersQuery.data ?? [])].sort((left, right) =>
    left.canonicalName.localeCompare(right.canonicalName),
  );
  return (
    <select aria-label={label} value={value} onChange={(changeEvent) => onChange(changeEvent.target.value)} className={`${CONTROL_CLASS} max-w-64`}>
      <option value="">Choose a partner…</option>
      {partners.map((partner) => (
        <option key={partner.partnerId} value={partner.partnerId}>
          {partner.canonicalName}
        </option>
      ))}
    </select>
  );
}

function CountryInput({ label, value, onChange }: { label: string; value: string; onChange(nextValue: string): void }) {
  const { idToken } = useAuth();
  const countriesQuery = useQuery({
    queryKey: ["crm", "countries"],
    queryFn: () => adminApi.listCountries(idToken!),
    enabled: idToken !== null,
  });
  const datalistId = "review-country-codes";
  return (
    <>
      <input
        aria-label={label}
        list={datalistId}
        value={value}
        maxLength={2}
        placeholder="ISO code, e.g. AE"
        onChange={(changeEvent) => onChange(changeEvent.target.value.toUpperCase())}
        className={`${CONTROL_CLASS} mrz w-36`}
      />
      <datalist id={datalistId}>
        {(countriesQuery.data ?? []).map((country) => (
          <option key={country.countryCode} value={country.countryCode}>
            {country.countryName}
          </option>
        ))}
      </datalist>
    </>
  );
}

