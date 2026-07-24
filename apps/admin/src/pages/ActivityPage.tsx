import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  APPLICATION_STATUSES,
  ACTIVITY_EVENT_TYPES,
  type ActivityEvent,
  type ActivityEventType,
  type Application,
  type ApplicationStatus,
  type PaymentStatus,
  type User,
} from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { eventToSentence, type HumanizerContext } from "../lib/activityHumanizer";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";
import { PAYMENT_LABELS, STATUS_LABELS } from "../lib/labels";

const DAYS_BACK_OPTIONS = [1, 7, 30] as const;

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

function shortId(value: string): string {
  return value.slice(0, 10);
}

export function ActivityPage() {
  const { idToken } = useAuth();
  const [daysBack, setDaysBack] = useState<(typeof DAYS_BACK_OPTIONS)[number]>(7);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEventTypes, setSelectedEventTypes] = useState<
    Set<ActivityEventType> | "ALL"
  >("ALL");

  const activityQuery = useQuery({
    queryKey: ["admin-activity", daysBack],
    queryFn: () => adminApi.listActivity(idToken!, { daysBack }),
    enabled: idToken !== null,
  });

  const statusCountQueries = useQueries({
    queries: APPLICATION_STATUSES.map((status) => ({
      queryKey: ["admin-applications", status],
      queryFn: () => adminApi.listApplications(idToken!, status),
      enabled: idToken !== null,
    })),
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

  const allApplications = useMemo(
    () =>
      statusCountQueries.flatMap(
        (statusQuery) => statusQuery.data ?? [],
      ) as Application[],
    [statusCountQueries],
  );

  const applicationById = useMemo(() => {
    const byId = new Map<string, Application>();
    for (const application of allApplications) {
      byId.set(application.applicationId, application);
    }
    return byId;
  }, [allApplications]);

  const userNameById = useMemo(() => {
    const byId = new Map<string, User>();
    for (const userProfile of usersQuery.data ?? []) {
      byId.set(userProfile.userId, userProfile);
    }
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
    () => ({ countryNameByCode, userNameById, applicationById }),
    [countryNameByCode, userNameById, applicationById],
  );

  const filteredEvents = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return (activityQuery.data ?? []).filter((activityEvent) => {
      if (
        selectedEventTypes !== "ALL" &&
        !selectedEventTypes.has(activityEvent.eventType)
      ) {
        return false;
      }
      if (normalizedQuery.length === 0) return true;
      const userProfile = userNameById.get(activityEvent.userId);
      const application = activityEvent.applicationId
        ? applicationById.get(activityEvent.applicationId)
        : undefined;
      const countryName = application
        ? (countryNameByCode.get(application.countryCode) ?? application.countryCode)
        : "";
      const travellerNames = (application?.travellers ?? [])
        .map((traveller) => traveller.fullName)
        .join(" ");
      const haystack = [
        userProfile?.fullName ?? "",
        userProfile?.email ?? "",
        activityEvent.actorEmail ?? "",
        activityEvent.userId,
        activityEvent.applicationId ?? "",
        travellerNames,
        countryName,
        activityEvent.eventType,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [
    activityQuery.data,
    searchQuery,
    selectedEventTypes,
    userNameById,
    applicationById,
    countryNameByCode,
  ]);

  const eventsByApplicationId = useMemo(() => {
    const grouped = new Map<string, ActivityEvent[]>();
    for (const activityEvent of filteredEvents) {
      if (!activityEvent.applicationId) continue;
      const existingEvents = grouped.get(activityEvent.applicationId) ?? [];
      existingEvents.push(activityEvent);
      grouped.set(activityEvent.applicationId, existingEvents);
    }
    for (const events of grouped.values()) {
      events.sort((leftEvent, rightEvent) =>
        rightEvent.createdAt.localeCompare(leftEvent.createdAt),
      );
    }
    return grouped;
  }, [filteredEvents]);

  const applicationTimelineCards = useMemo(() => {
    return [...eventsByApplicationId.entries()]
      .map(([applicationId, events]) => {
        const application = applicationById.get(applicationId);
        const newestEventAt = events[0]?.createdAt ?? "";
        return { applicationId, events, application, newestEventAt };
      })
      .sort((leftCard, rightCard) =>
        rightCard.newestEventAt.localeCompare(leftCard.newestEventAt),
      );
  }, [eventsByApplicationId, applicationById]);

  const accountEvents = useMemo(
    () =>
      filteredEvents
        .filter((activityEvent) => activityEvent.applicationId === undefined)
        .sort((leftEvent, rightEvent) =>
          rightEvent.createdAt.localeCompare(leftEvent.createdAt),
        ),
    [filteredEvents],
  );

  const isLoading =
    activityQuery.isLoading ||
    usersQuery.isLoading ||
    countriesQuery.isLoading ||
    statusCountQueries.some((statusQuery) => statusQuery.isLoading);

  function toggleEventType(eventType: ActivityEventType): void {
    setSelectedEventTypes((previousSelection) => {
      if (previousSelection === "ALL") {
        return new Set([eventType]);
      }
      const nextSelection = new Set(previousSelection);
      if (nextSelection.has(eventType)) nextSelection.delete(eventType);
      else nextSelection.add(eventType);
      return nextSelection.size === 0 ? "ALL" : nextSelection;
    });
  }

  return (
    <AdminShell>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Activity</h1>
        <p className="mt-1 text-ink-soft">
          Application-first timeline of what users and admins are doing.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        <input
          type="search"
          placeholder="Search by applicant, email, country, or application ID…"
          value={searchQuery}
          onChange={(changeEvent) => setSearchQuery(changeEvent.target.value)}
          className="w-full max-w-md rounded-xl border border-line bg-paper px-4 py-2.5 text-sm focus:border-ink/30"
        />
        <div className="flex flex-wrap gap-2">
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
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedEventTypes("ALL")}
            className={`rounded-full px-3 py-1.5 text-[10px] font-semibold ${
              selectedEventTypes === "ALL"
                ? "bg-ink text-paper"
                : "border border-line bg-paper text-ink-soft"
            }`}
          >
            All events
          </button>
          {ACTIVITY_EVENT_TYPES.map((eventType) => {
            const isActive =
              selectedEventTypes !== "ALL" && selectedEventTypes.has(eventType);
            return (
              <button
                key={eventType}
                type="button"
                onClick={() => toggleEventType(eventType)}
                className={`rounded-full px-3 py-1.5 text-[10px] font-semibold ${
                  isActive
                    ? "bg-ink text-paper"
                    : "border border-line bg-paper text-ink-soft"
                }`}
              >
                {eventType}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <p className="text-ink-soft">Loading activity…</p>
      ) : (
        <div className="space-y-10">
          <section className="space-y-4">
            <h2 className="text-lg font-bold">By application</h2>
            {applicationTimelineCards.length === 0 ? (
              <p className="text-sm text-ink-soft">
                No application events in this window.
              </p>
            ) : (
              applicationTimelineCards.map((timelineCard) => (
                <ApplicationTimelineCard
                  key={timelineCard.applicationId}
                  applicationId={timelineCard.applicationId}
                  application={timelineCard.application}
                  events={timelineCard.events}
                  countryNameByCode={countryNameByCode}
                  userNameById={userNameById}
                  humanizerContext={humanizerContext}
                />
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold">Account & platform</h2>
            {accountEvents.length === 0 ? (
              <p className="text-sm text-ink-soft">No account/platform events.</p>
            ) : (
              <ul className="space-y-2">
                {accountEvents.map((activityEvent) => {
                  const humanized = eventToSentence(activityEvent, humanizerContext);
                  return (
                    <li
                      key={activityEvent.eventId}
                      className="rounded-2xl border border-line bg-paper px-4 py-3 text-sm"
                    >
                      <span className="mr-2">{humanized.icon}</span>
                      {humanized.text}
                      <span className="ml-2 text-xs text-ink-soft">
                        · {relativeTime(activityEvent.createdAt)}
                      </span>
                      <Link
                        to={`/users/${activityEvent.userId}`}
                        className="ml-2 mrz text-[10px] text-rgs-red hover:underline"
                      >
                        {shortId(activityEvent.userId)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}

function ApplicationTimelineCard({
  applicationId,
  application,
  events,
  countryNameByCode,
  userNameById,
  humanizerContext,
}: {
  applicationId: string;
  application: Application | undefined;
  events: ActivityEvent[];
  countryNameByCode: Map<string, string>;
  userNameById: Map<string, User>;
  humanizerContext: HumanizerContext;
}) {
  const ownerProfile = application
    ? userNameById.get(application.userId)
    : undefined;
  const countryName = application
    ? (countryNameByCode.get(application.countryCode) ?? application.countryCode)
    : "Unknown country";
  const status = (application?.status ?? "DRAFT") as ApplicationStatus;
  const paymentStatus = application?.paymentStatus ?? "UNPAID";

  // The applicants are the travellers on the application (not the account holder,
  // who may be booking on someone else's behalf). Drafts may carry blank/placeholder
  // names, so filter those out and fall back to the account identity.
  const travellerNames = (application?.travellers ?? [])
    .map((traveller) => traveller.fullName.trim())
    .filter((name) => name.length > 0 && name !== "PENDING");
  const accountIdentity =
    ownerProfile?.fullName ??
    ownerProfile?.email ??
    shortId(application?.userId ?? "unknown");
  const applicantLabel =
    travellerNames.length === 0
      ? accountIdentity
      : travellerNames.length <= 2
        ? travellerNames.join(", ")
        : `${travellerNames[0]} +${travellerNames.length - 1} more`;

  return (
    <article className="rounded-2xl border border-line bg-paper overflow-hidden">
      <header className="border-b border-line bg-mist/50 px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
        <div>
          <p className="font-bold">
            {countryName} · {applicantLabel}
          </p>
          <p className="text-xs text-ink-soft">
            booked by {ownerProfile?.email ?? accountIdentity}
            {travellerNames.length > 1 ? ` · ${travellerNames.length} travellers` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-ink/5 px-2.5 py-0.5 font-semibold">
            {STATUS_LABELS[status]}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 font-semibold ${PAYMENT_CHIP_CLASSES[paymentStatus]}`}
          >
            {PAYMENT_LABELS[paymentStatus]}
          </span>
          <span className="text-ink-soft">
            {events[0] ? relativeTime(events[0].createdAt) : ""}
          </span>
          <Link
            to={`/applications/${applicationId}`}
            className="font-semibold text-rgs-red hover:underline"
          >
            Open
          </Link>
          {application && (
            <Link
              to={`/users/${application.userId}`}
              className="font-semibold text-ink-soft hover:underline"
            >
              User
            </Link>
          )}
        </div>
      </header>
      <ul className="divide-y divide-line">
        {events.map((activityEvent) => {
          const humanized = eventToSentence(activityEvent, humanizerContext);
          return (
            <li key={activityEvent.eventId} className="px-4 py-2.5 text-sm flex gap-3">
              <span aria-hidden="true">{humanized.icon}</span>
              <div className="flex-1">
                <p>{humanized.text}</p>
                <p className="text-xs text-ink-soft">
                  {relativeTime(activityEvent.createdAt)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
