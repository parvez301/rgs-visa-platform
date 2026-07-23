import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import type { ActivityEvent } from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

const DAYS_BACK_OPTIONS = [1, 2, 7] as const;

function formatTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoTimestamp));
}

function metaSummary(activityEvent: ActivityEvent): string {
  return Object.entries(activityEvent.meta)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

export function ActivityPage() {
  const { idToken } = useAuth();
  const [daysBack, setDaysBack] = useState<(typeof DAYS_BACK_OPTIONS)[number]>(2);

  const activityQuery = useQuery({
    queryKey: ["admin-activity", daysBack],
    queryFn: () => adminApi.listActivity(idToken!, { daysBack }),
    enabled: idToken !== null,
  });

  const events = activityQuery.data ?? [];

  return (
    <AdminShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Activity</h1>
          <p className="mt-1 text-ink-soft">Recent events across the platform.</p>
        </div>
        <div className="flex gap-2">
          {DAYS_BACK_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDaysBack(option)}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${
                daysBack === option
                  ? "bg-ink text-paper"
                  : "border border-line bg-paper text-ink-soft"
              }`}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      {activityQuery.isLoading ? (
        <p className="text-ink-soft">Loading activity…</p>
      ) : (
        <ul className="space-y-2">
          {events.map((activityEvent) => (
            <li
              key={activityEvent.eventId}
              className="rounded-2xl border border-line bg-paper px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-xs text-ink-soft">{formatTime(activityEvent.createdAt)}</span>
                <span className="rounded-full bg-mist px-2 py-0.5 text-[10px] font-semibold">
                  {activityEvent.eventType}
                </span>
                <Link
                  to={`/users/${activityEvent.userId}`}
                  className="mrz text-[10px] text-rgs-red hover:underline"
                >
                  {activityEvent.userId.slice(0, 12)}
                </Link>
                {activityEvent.applicationId && (
                  <Link
                    to={`/applications/${activityEvent.applicationId}`}
                    className="mrz text-[10px] text-ink-soft hover:text-rgs-red"
                  >
                    app {activityEvent.applicationId.slice(0, 10)}
                  </Link>
                )}
              </div>
              <p className="text-ink-soft text-xs">{metaSummary(activityEvent) || "—"}</p>
            </li>
          ))}
          {events.length === 0 && (
            <li className="text-ink-soft py-8 text-center">No activity in this window.</li>
          )}
        </ul>
      )}
    </AdminShell>
  );
}
