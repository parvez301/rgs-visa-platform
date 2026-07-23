export interface ServicePageContent {
  slug: string;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  offerings: Array<{ title: string; detail: string }>;
  whyRgs: string[];
}

export const SERVICES_CONTENT: ServicePageContent[] = [
  {
    slug: "visa-assistance",
    name: "Visa Assistance Services",
    shortName: "Visa assistance",
    tagline: "Every visa type, for 60+ countries, handled end to end.",
    description:
      "One missing document or a small error can cost weeks of waiting. Our consultants guide you step by step — forms filled correctly, documents complete, application submitted on time and followed up until decision.",
    offerings: [
      {
        title: "Application & documentation",
        detail:
          "Experts fill visa forms with you, assemble the exact document set the embassy expects, and submit on time.",
      },
      {
        title: "Document verification",
        detail:
          "Every page is reviewed for gaps and errors before submission — the single biggest factor in approval rates.",
      },
      {
        title: "Interview preparation",
        detail:
          "For interview countries (US, Schengen and more): likely questions, tips and mock preparation so you walk in confident.",
      },
      {
        title: "Work & immigration visas",
        detail:
          "Beyond tourist visas — work permits, long-stay and immigration advice with honest assessment of your chances.",
      },
    ],
    whyRgs: [
      "15 years processing visas from Delhi",
      "Transparent pricing, no hidden fees",
      "Follow-up with embassy/VFS until decision",
      "Tourist visas for 8 countries fully online on our portal",
    ],
  },
  {
    slug: "study-abroad",
    name: "Study Abroad Consultancy",
    shortName: "Study abroad",
    tagline: "Your bridge to global education — dream, apply, achieve.",
    description:
      "End-to-end support for students: choosing the right country, course and university for your goals and budget, admissions, student visa, and everything until you land and settle.",
    offerings: [
      {
        title: "University shortlisting & admissions",
        detail:
          "Personalised guidance to match your academic goals, budget and career plans with the best-fit country, course and university.",
      },
      {
        title: "Student visa filing",
        detail:
          "Complete visa documentation, financial planning guidance, and application filing with interview prep where needed.",
      },
      {
        title: "Pre-departure briefing",
        detail:
          "Flights, forex, accommodation guidance and a clear checklist of what to carry and what to expect.",
      },
      {
        title: "Post-arrival support",
        detail:
          "We stay reachable after you land — from registration formalities to parent visits later.",
      },
    ],
    whyRgs: [
      "Students placed across UK, USA, Canada, Australia and Europe",
      "Honest advice on chances — no overselling",
      "One office for admission, visa, ticket and insurance",
      "Support continues after you reach campus",
    ],
  },
  {
    slug: "passport-assistance",
    name: "Passport Assistance",
    shortName: "Passport assistance",
    tagline: "First passport, renewal or urgent Tatkal — without the queues and confusion.",
    description:
      "Long procedures, confusing documentation, changing requirements — we handle the entire Passport Seva process: correct online application, the right annexures, and preparation for your PSK/RPO visit.",
    offerings: [
      {
        title: "New passport applications",
        detail:
          "We explain exactly which documents you need — citizenship proof, identity, address and date-of-birth — and file the online application error-free.",
      },
      {
        title: "Renewals & reissues",
        detail:
          "Expired passport, exhausted pages, damaged booklet or name change after marriage — each has its own document set; we prepare it right the first time.",
      },
      {
        title: "Tatkal (urgent) applications",
        detail:
          "Travelling soon? We prepare the specific annexure forms Tatkal requires and guide you to the fastest appointment.",
      },
      {
        title: "Minor & special cases",
        detail:
          "Passports for children, applicants with single parents, and other special cases that need extra annexures and care.",
      },
    ],
    whyRgs: [
      "Complete PSK/RPO visit preparation — originals + photocopies checklist",
      "Error-free filing prevents rejection-and-refile cycles",
      "Guidance for Aadhaar, Voter ID, PAN and other accepted proofs",
      "Delhi-NCR appointments handled smartly",
    ],
  },
  {
    slug: "attestation-legalization",
    name: "Attestation & Legalization",
    shortName: "Attestation",
    tagline: "Document attestation, apostille and embassy legalization — done right.",
    description:
      "Employment abroad, higher studies, or family visas often need your documents attested or apostilled. We manage the full chain — notary, state, MEA and embassy — so your documents come back accepted.",
    offerings: [
      {
        title: "MEA apostille",
        detail:
          "Apostille for Hague-convention countries on educational, personal and commercial documents.",
      },
      {
        title: "Embassy legalization",
        detail:
          "For non-Hague destinations (UAE, Qatar, Kuwait, Saudi and more) — full embassy attestation chain.",
      },
      {
        title: "Educational & personal documents",
        detail:
          "Degrees, transcripts, birth and marriage certificates, police clearance certificates.",
      },
      {
        title: "Commercial documents",
        detail: "Company documents for business setup and trade abroad.",
      },
    ],
    whyRgs: [
      "Single point of contact for the whole chain",
      "Tracking at every stage — you always know where your document is",
      "Correct sequence first time; no bounced documents",
      "Pickup and delivery available in Delhi-NCR",
    ],
  },
  {
    slug: "travel-insurance",
    name: "Travel Insurance",
    shortName: "Travel insurance",
    tagline: "Plans that satisfy embassy requirements and actually cover you.",
    description:
      "Many visas — Schengen especially — require insurance with specific minimum coverage. We issue compliant policies in minutes, with 20+ coverage benefits and plans tailored to your trip and budget.",
    offerings: [
      {
        title: "Visa-compliant policies",
        detail:
          "Coverage amounts and wording that embassies accept — Schengen's €30,000 requirement included.",
      },
      {
        title: "Medical & emergency cover",
        detail: "Hospitalisation, emergency evacuation and repatriation coverage abroad.",
      },
      {
        title: "Trip protection",
        detail: "Cancellations, delays, lost baggage and passport loss protection.",
      },
      {
        title: "Student & long-stay plans",
        detail: "Extended policies for students and long-duration travellers.",
      },
    ],
    whyRgs: [
      "Policy issued same day, often within minutes",
      "We match the policy to your visa's exact requirement",
      "Reasonable premiums with honest comparisons",
      "Claims guidance if something goes wrong on the trip",
    ],
  },
  {
    slug: "frro-indian-e-visa",
    name: "FRRO & Indian E-Visa Services",
    shortName: "FRRO & Indian e-visa",
    tagline: "For foreign nationals in India — registration, extensions and Indian e-visas.",
    description:
      "Foreign nationals visiting or staying in India face their own paperwork: FRRO registration, visa extensions, exit permissions and Indian e-visas. We handle these formalities so your stay stays compliant.",
    offerings: [
      {
        title: "FRRO registration",
        detail:
          "Mandatory registration for long-stay foreign nationals, filed correctly with the right supporting documents.",
      },
      {
        title: "Indian e-visa applications",
        detail: "Tourist, business and medical e-visas for foreign nationals visiting India.",
      },
      {
        title: "Visa extensions & conversions",
        detail: "Extensions and category changes processed through the e-FRRO portal.",
      },
      {
        title: "Exit permissions",
        detail: "Overstay regularisation and exit permits when documentation has gaps.",
      },
    ],
    whyRgs: [
      "Deep familiarity with the e-FRRO portal's quirks",
      "Support in English and Hindi",
      "Fast response for urgent exit cases",
      "Trusted by expats and their Indian employers",
    ],
  },
  {
    slug: "air-ticketing",
    name: "Air Ticketing",
    shortName: "Air ticketing",
    tagline: "Fares and itineraries that work with your visa timeline.",
    description:
      "Visa applications often need itineraries before approval, and travel dates shift when processing takes longer. We book fares that flex with your visa journey — including refundable dummy itineraries where embassies require them.",
    offerings: [
      {
        title: "International & domestic fares",
        detail: "Competitive fares across airlines, with honest advice on routing and baggage.",
      },
      {
        title: "Visa-friendly itineraries",
        detail:
          "Confirmed itineraries for visa files, structured so date changes don't burn your money.",
      },
      {
        title: "Group & family bookings",
        detail: "Coordinated bookings for families and groups travelling together.",
      },
      {
        title: "Changes & cancellations",
        detail: "We handle reschedules directly with airlines when plans move.",
      },
    ],
    whyRgs: [
      "Tickets aligned with visa processing dates",
      "One call for visa + ticket + insurance together",
      "No surprise fare jumps at payment",
      "Support when flights get disrupted",
    ],
  },
  {
    slug: "customized-tours",
    name: "Customized Tour Packages",
    shortName: "Customized tours",
    tagline: "Personalised itineraries for business and leisure travel.",
    description:
      "Not an off-the-shelf package company — we build itineraries around your dates, budget and interests, with visas, flights, stays and insurance handled by the same team.",
    offerings: [
      {
        title: "Leisure & family holidays",
        detail: "Complete holiday planning — destinations, hotels, transfers and experiences.",
      },
      {
        title: "Business travel",
        detail: "Efficient itineraries for meetings, exhibitions and multi-city business trips.",
      },
      {
        title: "Pilgrimage & special journeys",
        detail: "Umrah and other pilgrimage travel with compliant documentation.",
      },
      {
        title: "Everything bundled",
        detail: "Visa, tickets, insurance and stays from one office — one point of accountability.",
      },
    ],
    whyRgs: [
      "Itineraries built around visa realities",
      "15 years of destination knowledge",
      "Transparent per-head pricing",
      "24/7 reachable while you travel",
    ],
  },
];

export function getService(slug: string): ServicePageContent {
  const service = SERVICES_CONTENT.find((candidate) => candidate.slug === slug);
  if (!service) throw new Error(`No service content for slug ${slug}`);
  return service;
}
