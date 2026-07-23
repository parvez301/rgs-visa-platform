import type { DocType } from "@rgs/shared";

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  PASSPORT_BIO: "Passport bio page",
  PHOTO: "Passport-size photo",
  BANK_STATEMENT: "Bank statements (last 3–6 months)",
  FLIGHT_ITINERARY: "Return flight itinerary",
  HOTEL_BOOKING: "Hotel booking or stay proof",
  YELLOW_FEVER_CERT: "Yellow fever vaccination certificate",
  ITR: "Income tax returns (last 2 years)",
  EMPLOYMENT_PROOF: "Employment proof / business registration",
  COVER_LETTER: "Cover letter (we help you draft it)",
};

export interface CountryPageContent {
  slug: string;
  flagEmoji: string;
  heroTagline: string;
  intro: string;
  rejectionReasons: Array<{ title: string; detail: string }>;
  faqs: Array<{ question: string; answer: string }>;
}

const COMMON_REJECTIONS: Array<{ title: string; detail: string }> = [
  {
    title: "Passport validity too short",
    detail:
      "Most countries need your passport valid for at least 6 months beyond your travel date. We check this before submitting.",
  },
  {
    title: "Blurry or non-compliant documents",
    detail:
      "Unclear passport scans and photos that don't meet government guidelines are the most common cause of delays. Our team reviews every document before it goes to immigration.",
  },
  {
    title: "Previous visa violations",
    detail:
      "Overstays or violations on earlier trips can lead to rejection. Tell us about your travel history and we'll advise the right way to apply.",
  },
];

export const COUNTRY_CONTENT: Record<string, CountryPageContent> = {
  AE: {
    slug: "uae-visa",
    flagEmoji: "🇦🇪",
    heroTagline: "Dubai (UAE) visa for Indians",
    intro:
      "The UAE e-visa is fully paperless — no embassy visit, no original passport submission. Upload your passport and photo, and our team handles the rest with immigration.",
    rejectionReasons: COMMON_REJECTIONS,
    faqs: [
      {
        question: "Do I need to visit an embassy?",
        answer:
          "No. The UAE visa is a fully online e-visa. You upload documents on our portal and receive the approved visa by email.",
      },
      {
        question: "Can I visit all seven Emirates on this visa?",
        answer:
          "Yes. One UAE visa covers Dubai, Abu Dhabi, Sharjah, Ras Al Khaimah, Fujairah, Umm Al Quwain and Ajman.",
      },
      {
        question: "How early should I apply?",
        answer:
          "We recommend applying at least a week before travel. Standard processing is about 4 working days.",
      },
    ],
  },
  AU: {
    slug: "australia-visa",
    flagEmoji: "🇦🇺",
    heroTagline: "Australia visitor visa (subclass 600) for Indians",
    intro:
      "Australia's visitor visa is lodged online with the Department of Home Affairs. Our specialists prepare and lodge your file, track it, and keep you updated at every step.",
    rejectionReasons: [
      ...COMMON_REJECTIONS,
      {
        title: "Insufficient funds or ties to India",
        detail:
          "Australia looks closely at bank statements and your reason to return. We help you present a strong, honest file.",
      },
    ],
    faqs: [
      {
        question: "How long can I stay?",
        answer:
          "The visitor visa is typically granted for stays of up to 3 months per visit, valid for 12 months with multiple entries.",
      },
      {
        question: "Do I need biometrics?",
        answer:
          "Most Indian applicants must give biometrics at a VFS centre after lodgement. We book the appointment and tell you exactly what to carry.",
      },
      {
        question: "What bank balance do I need?",
        answer:
          "There is no official figure, but a healthy balance that comfortably covers your trip is expected. Our team reviews your statements before lodging.",
      },
    ],
  },
  CA: {
    slug: "canada-visa",
    flagEmoji: "🇨🇦",
    heroTagline: "Canada visitor visa (TRV) for Indians",
    intro:
      "Canada's temporary resident visa can be valid up to 10 years. We prepare your IRCC file, guide you through biometrics, and track the application until your passport is stamped.",
    rejectionReasons: [
      ...COMMON_REJECTIONS,
      {
        title: "Weak purpose-of-visit story",
        detail:
          "IRCC refuses files that don't clearly explain the trip. We write a strong, truthful submission letter with your application.",
      },
    ],
    faqs: [
      {
        question: "How long is the visa valid?",
        answer:
          "Canada usually issues multiple-entry visas valid until your passport expires — up to 10 years.",
      },
      {
        question: "Is an interview required?",
        answer:
          "Most visitor applications don't need an interview, only biometrics at a VFS centre.",
      },
      {
        question: "My passport is with IRCC — how long?",
        answer:
          "After approval you submit your passport for stamping, which typically takes 2–4 weeks.",
      },
    ],
  },
  NZ: {
    slug: "new-zealand-visa",
    flagEmoji: "🇳🇿",
    heroTagline: "New Zealand visitor visa for Indians",
    intro:
      "New Zealand's visitor visa is applied online through Immigration New Zealand. We prepare your file, upload your documents, and follow up until the decision.",
    rejectionReasons: COMMON_REJECTIONS,
    faqs: [
      {
        question: "How long can I stay?",
        answer: "Visitor visas typically allow stays up to 3 months per visit.",
      },
      {
        question: "Do I need travel insurance?",
        answer:
          "Not mandatory for the visa, but strongly recommended — we can arrange it with your application.",
      },
      {
        question: "Can family apply together?",
        answer: "Yes. Partners and children can be included, and we bundle the documentation for you.",
      },
    ],
  },
  TZ: {
    slug: "tanzania-visa",
    flagEmoji: "🇹🇿",
    heroTagline: "Tanzania e-visa for Indians",
    intro:
      "Heading for Serengeti, Kilimanjaro or Zanzibar? Tanzania's e-visa is fully online. We submit your application and deliver the approved visa to your inbox.",
    rejectionReasons: COMMON_REJECTIONS,
    faqs: [
      {
        question: "Is Zanzibar covered?",
        answer: "Yes. Zanzibar is part of Tanzania, so one e-visa covers the mainland and the islands.",
      },
      {
        question: "Single or multiple entry?",
        answer: "The standard tourist e-visa is single entry, valid for 90 days.",
      },
      {
        question: "Do I need yellow fever vaccination?",
        answer:
          "Only if you arrive from a yellow-fever country. Flying direct from India, it's not required but carrying the card is wise.",
      },
    ],
  },
  UG: {
    slug: "uganda-visa",
    flagEmoji: "🇺🇬",
    heroTagline: "Uganda e-visa for Indians",
    intro:
      "Gorilla trekking in Bwindi or business in Kampala — Uganda's e-visa is processed online in under a week. We handle the application end to end.",
    rejectionReasons: COMMON_REJECTIONS,
    faqs: [
      {
        question: "Is yellow fever vaccination required?",
        answer:
          "Yes — Uganda requires a yellow fever certificate from all travellers. Get vaccinated at least 10 days before travel.",
      },
      {
        question: "How long is the visa valid?",
        answer: "The tourist e-visa allows a stay of up to 45 days.",
      },
      {
        question: "Can I extend my stay?",
        answer: "Extensions are possible in-country through Ugandan immigration.",
      },
    ],
  },
  NG: {
    slug: "nigeria-visa",
    flagEmoji: "🇳🇬",
    heroTagline: "Nigeria e-visa for Indians",
    intro:
      "Nigeria issues pre-approved e-visas for business and tourism. Documentation matters here — our team has processed Nigerian files for years and knows exactly what immigration expects.",
    rejectionReasons: [
      ...COMMON_REJECTIONS,
      {
        title: "Missing invitation or hotel proof",
        detail:
          "Nigeria requires confirmed accommodation or a host invitation. We verify these documents before submission.",
      },
    ],
    faqs: [
      {
        question: "Business or tourist — which should I apply for?",
        answer:
          "If a Nigerian company is inviting you, apply for a business e-visa with their invitation letter. For tourism, confirmed hotel booking works.",
      },
      {
        question: "How long does processing take?",
        answer: "Typically around 10 working days. Apply at least 2 weeks before travel.",
      },
      {
        question: "Is the visa single entry?",
        answer: "Yes, the standard e-visa is single entry for stays up to 30 days.",
      },
    ],
  },
  ZM: {
    slug: "zambia-visa",
    flagEmoji: "🇿🇲",
    heroTagline: "Zambia e-visa for Indians",
    intro:
      "Victoria Falls from the Zambian side, safaris in South Luangwa — Zambia's e-visa is quick and affordable. We process it online and deliver in days.",
    rejectionReasons: COMMON_REJECTIONS,
    faqs: [
      {
        question: "Can I visit Zimbabwe too?",
        answer:
          "Consider the KAZA UniVisa at the border for both sides of Victoria Falls, or apply for separate visas — our team will advise based on your route.",
      },
      {
        question: "How long is the visa valid?",
        answer: "The tourist e-visa allows stays up to 30 days, valid for 90 days from issue.",
      },
      {
        question: "What documents do I need?",
        answer: "Just your passport bio page and a photo. We handle the rest online.",
      },
    ],
  },
};

export function countrySlug(countryCode: string): string {
  const content = COUNTRY_CONTENT[countryCode];
  if (!content) throw new Error(`No marketing content for country ${countryCode}`);
  return content.slug;
}

export function countryCodeFromSlug(slug: string): string {
  const entry = Object.entries(COUNTRY_CONTENT).find(([, content]) => content.slug === slug);
  if (!entry) throw new Error(`No country for slug ${slug}`);
  return entry[0];
}
