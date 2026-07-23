"use client";

import { useState } from "react";
import { CONTACT_EMAIL } from "@/lib/site";

export function ContactForm() {
  const [enquirerName, setEnquirerName] = useState("");
  const [enquirerPhone, setEnquirerPhone] = useState("");
  const [enquiryTopic, setEnquiryTopic] = useState("Visa assistance");
  const [enquiryMessage, setEnquiryMessage] = useState("");

  function composeMailto(): string {
    const subject = `${enquiryTopic} enquiry from ${enquirerName || "website visitor"}`;
    const body = [
      `Name: ${enquirerName}`,
      `Phone: ${enquirerPhone}`,
      `Topic: ${enquiryTopic}`,
      "",
      enquiryMessage,
    ].join("\n");
    return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-rgs-red outline-none";

  return (
    <form
      className="space-y-4"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        window.location.href = composeMailto();
      }}
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Your name</span>
          <input
            className={inputClasses}
            value={enquirerName}
            onChange={(changeEvent) => setEnquirerName(changeEvent.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Phone</span>
          <input
            className={inputClasses}
            type="tel"
            value={enquirerPhone}
            onChange={(changeEvent) => setEnquirerPhone(changeEvent.target.value)}
            required
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">What do you need?</span>
        <select
          className={inputClasses}
          value={enquiryTopic}
          onChange={(changeEvent) => setEnquiryTopic(changeEvent.target.value)}
        >
          {[
            "Visa assistance",
            "Study abroad",
            "Passport assistance",
            "Attestation & legalization",
            "Travel insurance",
            "FRRO & Indian e-visa",
            "Air ticketing",
            "Customized tours",
            "Something else",
          ].map((topic) => (
            <option key={topic}>{topic}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Message</span>
        <textarea
          className={`${inputClasses} min-h-28`}
          value={enquiryMessage}
          onChange={(changeEvent) => setEnquiryMessage(changeEvent.target.value)}
          placeholder="Destination, travel dates, number of travellers…"
        />
      </label>
      <button
        type="submit"
        className="rounded-full bg-rgs-red px-8 py-3.5 font-semibold text-white hover:bg-rgs-red-deep transition-colors"
      >
        Send enquiry
      </button>
      <p className="text-xs text-ink-soft">
        Opens your email app with the message pre-filled — or just call us.
      </p>
    </form>
  );
}
