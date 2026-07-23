import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  type PaymentStatus,
} from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

const PAYMENT_CHIP_CLASSES: Record<PaymentStatus, string> = {
  UNPAID: "bg-amber-100 text-amber-900",
  REQUESTED: "bg-sky-100 text-sky-900",
  PAID_OFFLINE: "bg-emerald-100 text-emerald-900",
};

function relativeTime(isoTimestamp: string): string {
  const deltaMs = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortId(applicationId: string): string {
  return applicationId.slice(0, 10);
}

export function QueuePage() {
  const { idToken } = useAuth();
  const navigate = useNavigate();
  const [selectedStatus, setSelectedStatus] =
    useState<ApplicationStatus | "ALL">("SUBMITTED");

  const statusCountQueries = useQueries({
    queries: APPLICATION_STATUSES.map((status) => ({
      queryKey: ["admin-applications", status],
      queryFn: () => adminApi.listApplications(idToken!, status),
      enabled: idToken !== null,
    })),
  });

  const activityWeekQuery = useQuery({
    queryKey: ["admin-activity", 7],
    queryFn: () => adminApi.listActivity(idToken!, { daysBack: 7 }),
    enabled: idToken !== null,
  });

  const leadsQuery = useQuery({
    queryKey: ["admin-leads"],
    queryFn: () => adminApi.listLeads(idToken!),
    enabled: idToken !== null,
  });

  const countsByStatus = useMemo(() => {
    const counts: Partial<Record<ApplicationStatus, number>> = {};
    APPLICATION_STATUSES.forEach((status, statusIndex) => {
      counts[status] = statusCountQueries[statusIndex]?.data?.length ?? 0;
    });
    return counts;
  }, [statusCountQueries]);

  const allApplications = useMemo(() => {
    return statusCountQueries.flatMap(
      (statusQuery) => statusQuery.data ?? [],
    ) as Application[];
  }, [statusCountQueries]);

  const draftApplications =
    statusCountQueries[APPLICATION_STATUSES.indexOf("DRAFT")]?.data ?? [];
  const abandonedDraftCount = draftApplications.filter((application) => {
    const ageMs = Date.now() - new Date(application.updatedAt).getTime();
    return ageMs > 24 * 60 * 60 * 1000;
  }).length;

  const signupsThisWeek = (activityWeekQuery.data ?? []).filter(
    (activityEvent) => activityEvent.eventType === "SIGNED_UP",
  ).length;
  const newLeadsCount = leadsQuery.data?.length ?? 0;

  const filteredApplications =
    selectedStatus === "ALL"
      ? [...allApplications].sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        )
      : (statusCountQueries[APPLICATION_STATUSES.indexOf(selectedStatus)]?.data ?? []);

  const isLoading = statusCountQueries.some((statusQuery) => statusQuery.isLoading);

  return (
    <AdminShell>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Application queue</h1>
        <p className="mt-1 text-ink-soft">Review submissions and advance each case.</p>
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Signups this week" value={String(signupsThisWeek)} />
        <MetricTile
          label="Applications by status"
          value={APPLICATION_STATUSES.map(
            (status) => `${status.slice(0, 3)} ${countsByStatus[status] ?? 0}`,
          ).join(" · ")}
          compact
        />
        <MetricTile label="Abandoned drafts (>24h)" value={String(abandonedDraftCount)} />
        <MetricTile label="New leads" value={String(newLeadsCount)} />
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <StatusTab
          label="All"
          count={allApplications.length}
          isActive={selectedStatus === "ALL"}
          onSelect={() => setSelectedStatus("ALL")}
        />
        {APPLICATION_STATUSES.map((status) => (
          <StatusTab
            key={status}
            label={status}
            count={countsByStatus[status] ?? 0}
            isActive={selectedStatus === status}
            onSelect={() => setSelectedStatus(status)}
          />
        ))}
      </div>

      {isLoading ? (
        <p className="text-ink-soft">Loading queue…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-mist text-ink-soft">
              <tr>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Travellers</th>
                <th className="px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredApplications.map((application) => (
                <tr
                  key={application.applicationId}
                  onClick={() =>
                    navigate(`/applications/${application.applicationId}`)
                  }
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-mist/70 transition-colors"
                >
                  <td className="px-4 py-3 mrz text-xs">{shortId(application.applicationId)}</td>
                  <td className="px-4 py-3 font-medium">{application.countryCode}</td>
                  <td className="px-4 py-3">{application.travellers.length}</td>
                  <td className="px-4 py-3 text-ink-soft">
                    {relativeTime(application.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${PAYMENT_CHIP_CLASSES[application.paymentStatus]}`}
                    >
                      {application.paymentStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-medium">{application.status}</td>
                </tr>
              ))}
              {filteredApplications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-ink-soft">
                    No applications in this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

function StatusTab({
  label,
  count,
  isActive,
  onSelect,
}: {
  label: string;
  count: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
        isActive
          ? "bg-ink text-paper"
          : "border border-line bg-paper text-ink-soft hover:border-ink/30"
      }`}
    >
      {label}{" "}
      <span className={isActive ? "text-paper/80" : "text-ink-soft"}>({count})</span>
    </button>
  );
}

function MetricTile({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <p className="mrz text-[10px] text-ink-soft mb-2">{label}</p>
      <p className={compact ? "text-xs font-semibold leading-relaxed" : "text-3xl font-bold"}>
        {value}
      </p>
    </div>
  );
}
