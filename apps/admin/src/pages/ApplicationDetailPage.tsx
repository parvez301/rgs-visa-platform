import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  LEGAL_STATUS_TRANSITIONS,
  type ApplicationStatus,
  type DocReviewStatus,
  type DocType,
} from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

const DOC_REVIEW_CLASSES: Record<DocReviewStatus, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-900",
  REJECTED: "bg-rgs-red/10 text-rgs-red",
};

export function ApplicationDetailPage() {
  const { applicationId = "" } = useParams<{ applicationId: string }>();
  const { idToken, email } = useAuth();
  const queryClient = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState<{
    docType: DocType;
    travellerIndex: number;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [noteText, setNoteText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["admin-application", applicationId],
    queryFn: () => adminApi.getApplication(idToken!, applicationId),
    enabled: idToken !== null && applicationId.length > 0,
  });

  async function refetchAll(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["admin-application", applicationId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-applications"] });
  }

  const transitionMutation = useMutation({
    mutationFn: (toStatus: ApplicationStatus) =>
      adminApi.transition(idToken!, applicationId, toStatus, email!),
    onSuccess: () => void refetchAll(),
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "Transition failed"),
  });

  const paymentMutation = useMutation({
    mutationFn: (toPaymentStatus: "REQUESTED" | "PAID_OFFLINE") =>
      adminApi.setPayment(idToken!, applicationId, toPaymentStatus, email!),
    onSuccess: () => void refetchAll(),
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "Payment update failed"),
  });

  const reviewMutation = useMutation({
    mutationFn: (input: {
      docType: DocType;
      travellerIndex: number;
      decision: "APPROVED" | "REJECTED";
      rejectReason?: string;
    }) =>
      adminApi.reviewDocument(idToken!, {
        applicationId,
        docType: input.docType,
        travellerIndex: input.travellerIndex,
        decision: input.decision,
        userEmail: email!,
        rejectReason: input.rejectReason,
      }),
    onSuccess: () => {
      setRejectTarget(null);
      setRejectReason("");
      void refetchAll();
    },
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "Document review failed"),
  });

  const noteMutation = useMutation({
    mutationFn: (text: string) => adminApi.addNote(idToken!, applicationId, text),
    onSuccess: () => {
      setNoteText("");
      void refetchAll();
    },
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "Could not add note"),
  });

  if (detailQuery.isLoading) {
    return (
      <AdminShell>
        <p className="text-ink-soft">Loading application…</p>
      </AdminShell>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <AdminShell>
        <p className="text-rgs-red">Could not load this application.</p>
        <Link to="/" className="mt-4 inline-block text-sm font-medium text-rgs-red">
          ← Back to queue
        </Link>
      </AdminShell>
    );
  }

  const { application, documents } = detailQuery.data;
  const nextStatuses = LEGAL_STATUS_TRANSITIONS[application.status];

  return (
    <AdminShell>
      <Link to="/" className="text-sm font-medium text-ink-soft hover:text-rgs-red">
        ← Back to queue
      </Link>

      <div className="mt-4 mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">
            {application.countryCode} · {application.applicationId.slice(0, 12)}
          </h1>
          <p className="mt-1 text-ink-soft">
            Status <span className="font-semibold text-ink">{application.status}</span>
            {" · "}
            Payment{" "}
            <span className="font-semibold text-ink">{application.paymentStatus}</span>
          </p>
        </div>
      </div>

      {actionError && (
        <p className="mb-4 rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red">
          {actionError}
        </p>
      )}

      <section className="mb-8 rounded-2xl border border-line bg-paper p-5">
        <h2 className="font-semibold mb-3">Travellers</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-ink-soft">
              <tr>
                <th className="pb-2 pr-4 font-medium">#</th>
                <th className="pb-2 pr-4 font-medium">Name</th>
                <th className="pb-2 pr-4 font-medium">DOB</th>
                <th className="pb-2 pr-4 font-medium">Passport</th>
                <th className="pb-2 font-medium">Expiry</th>
              </tr>
            </thead>
            <tbody>
              {application.travellers.map((traveller, travellerIndex) => (
                <tr key={travellerIndex} className="border-t border-line">
                  <td className="py-2 pr-4">{travellerIndex + 1}</td>
                  <td className="py-2 pr-4 font-medium">{traveller.fullName}</td>
                  <td className="py-2 pr-4">{traveller.dateOfBirth}</td>
                  <td className="py-2 pr-4 mrz text-xs">{traveller.passportNumber}</td>
                  <td className="py-2">{traveller.passportExpiryDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="font-semibold mb-3">Documents</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((document) => (
            <div
              key={`${document.travellerIndex}-${document.docType}`}
              className="rounded-2xl border border-line bg-paper p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{document.docType}</p>
                  <p className="text-xs text-ink-soft">
                    Traveller {document.travellerIndex + 1}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${DOC_REVIEW_CLASSES[document.reviewStatus]}`}
                >
                  {document.reviewStatus}
                </span>
              </div>
              {document.rejectReason && (
                <p className="text-xs text-rgs-red">{document.rejectReason}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled
                  title="download in review build"
                  className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-soft cursor-not-allowed"
                >
                  View
                </button>
                {document.reviewStatus === "PENDING" && (
                  <>
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        reviewMutation.mutate({
                          docType: document.docType,
                          travellerIndex: document.travellerIndex,
                          decision: "APPROVED",
                        })
                      }
                      className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        setRejectTarget({
                          docType: document.docType,
                          travellerIndex: document.travellerIndex,
                        })
                      }
                      className="rounded-full bg-rgs-red px-3 py-1 text-xs font-semibold text-white hover:bg-rgs-red-deep disabled:opacity-60"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {documents.length === 0 && (
            <p className="text-sm text-ink-soft">No documents uploaded.</p>
          )}
        </div>
      </section>

      <section className="mb-8 rounded-2xl border border-line bg-paper p-5 space-y-3">
        <h2 className="font-semibold">Status transitions</h2>
        <div className="flex flex-wrap gap-2">
          {nextStatuses.length === 0 && (
            <p className="text-sm text-ink-soft">No further transitions from this status.</p>
          )}
          {nextStatuses.map((nextStatus) => (
            <button
              key={nextStatus}
              type="button"
              disabled={transitionMutation.isPending}
              onClick={() => {
                setActionError(null);
                transitionMutation.mutate(nextStatus);
              }}
              className="rounded-full border border-ink px-4 py-2 text-sm font-semibold hover:bg-ink hover:text-paper transition-colors disabled:opacity-60"
            >
              → {nextStatus}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-8 rounded-2xl border border-line bg-paper p-5 space-y-3">
        <h2 className="font-semibold">Payment</h2>
        <div className="flex flex-wrap gap-2">
          {application.paymentStatus === "UNPAID" && (
            <button
              type="button"
              disabled={paymentMutation.isPending}
              onClick={() => paymentMutation.mutate("REQUESTED")}
              className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
            >
              Request payment
            </button>
          )}
          {application.paymentStatus === "REQUESTED" && (
            <button
              type="button"
              disabled={paymentMutation.isPending}
              onClick={() => paymentMutation.mutate("PAID_OFFLINE")}
              className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              Mark paid
            </button>
          )}
          {application.paymentStatus === "PAID_OFFLINE" && (
            <p className="text-sm text-emerald-700 font-medium">Marked paid offline</p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-paper p-5 space-y-4">
        <h2 className="font-semibold">Internal notes</h2>
        <ul className="space-y-2 text-sm">
          {application.internalNotes.map((note, noteIndex) => (
            <li key={noteIndex} className="rounded-xl bg-mist px-3 py-2">
              {note}
            </li>
          ))}
          {application.internalNotes.length === 0 && (
            <li className="text-ink-soft">No notes yet.</li>
          )}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="flex-1 rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-ink/30"
            placeholder="Add an internal note…"
            value={noteText}
            onChange={(changeEvent) => setNoteText(changeEvent.target.value)}
          />
          <button
            type="button"
            disabled={noteMutation.isPending || noteText.trim().length === 0}
            onClick={() => noteMutation.mutate(noteText.trim())}
            className="rounded-full bg-ink px-5 py-3 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
          >
            Add note
          </button>
        </div>
      </section>

      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-paper p-6 shadow-xl">
            <h3 className="text-lg font-bold mb-2">Reject document</h3>
            <p className="text-sm text-ink-soft mb-4">
              {rejectTarget.docType} · Traveller {rejectTarget.travellerIndex + 1}
            </p>
            <label className="block mb-4">
              <span className="mb-1.5 block text-sm font-medium">Reason</span>
              <textarea
                rows={3}
                className="w-full rounded-xl border border-line px-4 py-3 text-sm focus:border-ink/30"
                value={rejectReason}
                onChange={(changeEvent) => setRejectReason(changeEvent.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason("");
                }}
                className="rounded-full px-4 py-2 text-sm font-medium text-ink-soft"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={reviewMutation.isPending || rejectReason.trim().length === 0}
                onClick={() =>
                  reviewMutation.mutate({
                    docType: rejectTarget.docType,
                    travellerIndex: rejectTarget.travellerIndex,
                    decision: "REJECTED",
                    rejectReason: rejectReason.trim(),
                  })
                }
                className="rounded-full bg-rgs-red px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
