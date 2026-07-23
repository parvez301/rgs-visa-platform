"use client";

import { useState } from "react";
import { CONTACT_EMAIL, CONTACT_PHONE, CONTACT_PHONE_HREF } from "@/lib/site";

// Staging default; prod build overrides via NEXT_PUBLIC_API_URL.
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "https://d3yks8h8m1.execute-api.ap-south-1.amazonaws.com";

const DESTINATION_OPTIONS = [
  "United Arab Emirates",
  "Australia",
  "Canada",
  "New Zealand",
  "Tanzania",
  "Uganda",
  "Nigeria",
  "Zambia",
  "Somewhere else",
];

type SubmissionState = "idle" | "sending" | "sent" | "failed";

export function HomeLeadForm() {
  const [enquirerName, setEnquirerName] = useState("");
  const [enquirerPhone, setEnquirerPhone] = useState("");
  const [destination, setDestination] = useState(DESTINATION_OPTIONS[0]!);
  const [submissionState, setSubmissionState] = useState<SubmissionState>("idle");

  async function handleSubmit(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    setSubmissionState("sending");
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/leads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: enquirerName,
          phone: enquirerPhone,
          topic: `Visa enquiry — ${destination}`,
          message: `Callback request from the website home page. Destination: ${destination}.`,
        }),
      });
      if (!response.ok) throw new Error(`Lead submit failed (${response.status})`);
      setSubmissionState("sent");
    } catch {
      setSubmissionState("failed");
    }
  }

  const inputClasses =
    "w-full rounded-full border border-line bg-paper px-5 py-3 text-sm focus:border-ink/30";

  if (submissionState === "sent") {
    return (
      <section className="border-b border-line bg-mist">
        <div className="mx-auto max-w-6xl px-4 py-8 text-center">
          <p className="font-display text-xl font-bold">
            Thanks, {enquirerName.split(" ")[0]} — we&apos;ve got your details.
          </p>
          <p className="mt-1 text-ink-soft">
            A consultant will call you back during business hours (Mon–Sat, 10am–7pm IST).
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-line bg-mist">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col md:flex-row md:items-end gap-3"
        >
          <p className="md:mr-4 md:pb-2.5 shrink-0">
            <span className="font-display font-bold">Prefer a call back?</span>
            <br />
            <span className="text-sm text-ink-soft">Leave your details — we&apos;ll ring you.</span>
          </p>
          <label className="flex-1">
            <span className="sr-only">Your name</span>
            <input
              className={inputClasses}
              placeholder="Your name"
              value={enquirerName}
              onChange={(changeEvent) => setEnquirerName(changeEvent.target.value)}
              required
            />
          </label>
          <label className="flex-1">
            <span className="sr-only">Phone number</span>
            <input
              className={inputClasses}
              type="tel"
              placeholder="Phone number"
              value={enquirerPhone}
              onChange={(changeEvent) => setEnquirerPhone(changeEvent.target.value)}
              minLength={8}
              required
            />
          </label>
          <label className="flex-1">
            <span className="sr-only">Destination</span>
            <select
              className={inputClasses}
              value={destination}
              onChange={(changeEvent) => setDestination(changeEvent.target.value)}
            >
              {DESTINATION_OPTIONS.map((destinationOption) => (
                <option key={destinationOption}>{destinationOption}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={submissionState === "sending"}
            className="rounded-full bg-rgs-red px-8 py-3 text-sm font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60 shrink-0"
          >
            {submissionState === "sending" ? "Sending…" : "Request call back"}
          </button>
        </form>
        {submissionState === "failed" && (
          <p className="mt-3 text-sm text-rgs-red-deep">
            Couldn&apos;t send just now — call us at{" "}
            <a href={CONTACT_PHONE_HREF} className="font-semibold underline">
              {CONTACT_PHONE}
            </a>{" "}
            or email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        )}
      </div>
    </section>
  );
}
