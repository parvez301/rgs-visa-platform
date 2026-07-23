import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

function formatTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoTimestamp));
}

export function UserActivityPage() {
  const { userId = "" } = useParams<{ userId: string }>();
  const { idToken } = useAuth();

  const activityQuery = useQuery({
    queryKey: ["admin-activity-user", userId],
    queryFn: () => adminApi.listActivity(idToken!, { userId }),
    enabled: idToken !== null && userId.length > 0,
  });

  const events = activityQuery.data ?? [];

  return (
    <AdminShell>
      <Link to="/activity" className="text-sm font-medium text-ink-soft hover:text-rgs-red">
        ← Back to activity
      </Link>
      <h1 className="mt-4 text-3xl font-bold mb-1">User activity</h1>
      <p className="mrz text-xs text-ink-soft mb-6">{userId}</p>

      {activityQuery.isLoading ? (
        <p className="text-ink-soft">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {events.map((activityEvent) => (
            <li
              key={activityEvent.eventId}
              className="rounded-2xl border border-line bg-paper px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-soft">{formatTime(activityEvent.createdAt)}</span>
                <span className="rounded-full bg-mist px-2 py-0.5 text-[10px] font-semibold">
                  {activityEvent.eventType}
                </span>
                {activityEvent.applicationId && (
                  <Link
                    to={`/applications/${activityEvent.applicationId}`}
                    className="mrz text-[10px] text-rgs-red hover:underline"
                  >
                    {activityEvent.applicationId.slice(0, 12)}
                  </Link>
                )}
              </div>
            </li>
          ))}
          {events.length === 0 && (
            <li className="text-ink-soft py-8 text-center">No events for this user.</li>
          )}
        </ul>
      )}
    </AdminShell>
  );
}
