import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router";
import type { Application } from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { eventToSentence } from "../lib/activityHumanizer";
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

  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => adminApi.listUsers(idToken!),
    enabled: idToken !== null,
  });

  const countriesQuery = useQuery({
    queryKey: ["admin-countries"],
    queryFn: () => adminApi.listCountries(idToken!),
    enabled: idToken !== null,
  });

  const userProfile = useMemo(
    () => (usersQuery.data ?? []).find((profile) => profile.userId === userId),
    [usersQuery.data, userId],
  );

  const userNameById = useMemo(() => {
    const byId = new Map(
      (usersQuery.data ?? []).map((profile) => [profile.userId, profile] as const),
    );
    return byId;
  }, [usersQuery.data]);

  const countryNameByCode = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const countryProduct of countriesQuery.data ?? []) {
      byCode.set(countryProduct.countryCode, countryProduct.countryName);
    }
    return byCode;
  }, [countriesQuery.data]);

  const humanizerContext = useMemo(
    // This page does not load applications, so traveller names can't be
    // resolved here — doc events fall back to "(traveller N)".
    () => ({ countryNameByCode, userNameById, applicationById: new Map<string, Application>() }),
    [countryNameByCode, userNameById],
  );

  const events = activityQuery.data ?? [];

  return (
    <AdminShell>
      <Link to="/activity" className="text-sm font-medium text-ink-soft hover:text-rgs-red">
        ← Back to activity
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-3xl font-bold mb-1">
          {userProfile?.fullName ?? "User activity"}
        </h1>
        {userProfile?.email ? (
          <p className="text-sm text-ink-soft">{userProfile.email}</p>
        ) : null}
        <p className="mrz text-xs text-ink-soft mt-1">{userId}</p>
      </header>

      {activityQuery.isLoading ? (
        <p className="text-ink-soft">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {events.map((activityEvent) => {
            const humanized = eventToSentence(activityEvent, humanizerContext);
            return (
              <li
                key={activityEvent.eventId}
                className="rounded-2xl border border-line bg-paper px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-xs text-ink-soft">
                    {formatTime(activityEvent.createdAt)}
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
                <p>
                  <span className="mr-2" aria-hidden="true">
                    {humanized.icon}
                  </span>
                  {humanized.text}
                </p>
              </li>
            );
          })}
          {events.length === 0 && (
            <li className="text-ink-soft py-8 text-center">No events for this user.</li>
          )}
        </ul>
      )}
    </AdminShell>
  );
}
