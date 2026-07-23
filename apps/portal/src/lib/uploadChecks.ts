import type { DocType } from "@rgs/shared";

/** Short do/don't guidance shown on each upload card. */
export const DOC_GUIDANCE: Record<DocType, string[]> = {
  PASSPORT_BIO: [
    "Photo page with your picture and details",
    "All four corners visible, no fingers over the page",
    "No glare — the two lines of <<< text at the bottom must be readable",
  ],
  PHOTO: [
    "Plain white background, taken within the last 6 months",
    "Face straight to camera, neutral expression",
    "No glasses, no cap; head and shoulders fill most of the frame",
  ],
  BANK_STATEMENT: [
    "Last 3–6 months, bank name and your name visible",
    "PDF from net-banking is best — avoid cropped screenshots",
  ],
  FLIGHT_ITINERARY: ["Booking or reservation showing your name and travel dates"],
  HOTEL_BOOKING: ["Confirmation showing your name, hotel and dates"],
  YELLOW_FEVER_CERT: [
    "The yellow WHO card, vaccination date at least 10 days before travel",
  ],
  ITR: ["Income tax return acknowledgement for the last 2 years"],
  EMPLOYMENT_PROOF: [
    "Employment letter / business registration / GST certificate",
  ],
  COVER_LETTER: ["We'll help you draft this — upload if you already have one"],
};

/** Deeper guide content for the "See example & rules" modal. */
export const DOC_GUIDE_DETAILS: Record<
  DocType,
  { donts: string[]; commonRejections: string[]; fileSpec: string }
> = {
  PASSPORT_BIO: {
    donts: [
      "Don't crop any edge of the page",
      "Don't shoot at an angle — hold the phone flat above the passport",
      "Don't use flash directly over the page (causes glare)",
    ],
    commonRejections: [
      "Glare covering the photo or the <<< machine-readable lines",
      "Blurry text — immigration systems read this page automatically",
      "Cover page or address page uploaded instead of the photo page",
    ],
    fileSpec: "JPEG/PNG/PDF · sharp and readable · at least 800px wide",
  },
  PHOTO: {
    donts: [
      "Don't wear glasses, caps, or headphones",
      "Don't smile with teeth — keep a neutral expression",
      "Don't use old photos, selfies with filters, or cropped group photos",
    ],
    commonRejections: [
      "Background not plain white / shadows behind the head",
      "Face too small in the frame — head and shoulders should fill most of it",
      "Photo older than 6 months or reused from an old visa",
    ],
    fileSpec: "JPEG/PNG · portrait · at least 400×400px",
  },
  BANK_STATEMENT: {
    donts: [
      "Don't upload cropped screenshots of the balance",
      "Don't hide transactions — embassies check statement continuity",
    ],
    commonRejections: [
      "Statement older than required (needs to be recent)",
      "Account holder name not visible on every page",
    ],
    fileSpec: "PDF preferred (net-banking download) · all pages",
  },
  FLIGHT_ITINERARY: {
    donts: ["Don't upload a price quote — it must show a booking/PNR reference"],
    commonRejections: ["Traveller name spelt differently than the passport"],
    fileSpec: "PDF or clear image showing name, dates, PNR",
  },
  HOTEL_BOOKING: {
    donts: ["Don't use unconfirmed carts or screenshots without your name"],
    commonRejections: ["Booking dates not covering the whole stay"],
    fileSpec: "PDF or clear image showing name, hotel, dates",
  },
  YELLOW_FEVER_CERT: {
    donts: ["Don't upload the appointment slip — it must be the yellow WHO card"],
    commonRejections: ["Vaccination date fewer than 10 days before travel"],
    fileSpec: "Clear photo of the full card, both pages if written on",
  },
  ITR: {
    donts: ["Don't upload just Form 16 — the ITR acknowledgement is required"],
    commonRejections: ["Only one year uploaded when two are required"],
    fileSpec: "PDF · last 2 assessment years",
  },
  EMPLOYMENT_PROOF: {
    donts: ["Don't use expired ID cards or unsigned letters"],
    commonRejections: ["Letter without company letterhead or date"],
    fileSpec: "PDF or clear image on letterhead",
  },
  COVER_LETTER: {
    donts: ["Don't worry about perfect wording — our team polishes it"],
    commonRejections: ["Missing travel dates or purpose"],
    fileSpec: "PDF preferred",
  },
};

export interface UploadCheckResult {
  /** Hard failures — upload is blocked. */
  blockers: string[];
  /** Soft issues — upload proceeds, traveller is warned. */
  warnings: string[];
}

const MIN_PHOTO_SIDE_PX = 400;
const MIN_PASSPORT_LONG_SIDE_PX = 800;
const BLURRY_FILE_BYTES = 60 * 1024;

function loadImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    image.src = objectUrl;
  });
}

/**
 * Cheap client-side quality gate — catches the uploads embassies reject most
 * (tiny/blurry images) before they cost the traveller a review round-trip.
 */
export async function checkFileBeforeUpload(
  docType: DocType,
  file: File,
): Promise<UploadCheckResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (file.type === "application/pdf") {
    return { blockers, warnings };
  }

  const dimensions = await loadImageDimensions(file);
  if (!dimensions) {
    blockers.push("This image can't be read — try another photo or a PDF.");
    return { blockers, warnings };
  }

  const shorterSide = Math.min(dimensions.width, dimensions.height);
  const longerSide = Math.max(dimensions.width, dimensions.height);

  if (docType === "PHOTO") {
    if (shorterSide < MIN_PHOTO_SIDE_PX) {
      blockers.push(
        `Photo is too small (${dimensions.width}×${dimensions.height}). Use your phone's camera — at least ${MIN_PHOTO_SIDE_PX}px on each side.`,
      );
    }
    const aspectRatio = dimensions.width / dimensions.height;
    if (aspectRatio > 1.15) {
      warnings.push(
        "Photo looks landscape — passport photos should be portrait (taller than wide).",
      );
    }
  } else if (docType === "PASSPORT_BIO") {
    if (longerSide < MIN_PASSPORT_LONG_SIDE_PX) {
      blockers.push(
        `Scan is too small (${dimensions.width}×${dimensions.height}) — the passport text won't be readable. Take a closer, sharper photo.`,
      );
    }
  } else if (shorterSide < 300) {
    warnings.push("This image is quite small — make sure the text is readable.");
  }

  if (file.size < BLURRY_FILE_BYTES && file.type !== "image/png") {
    warnings.push(
      "The file is very light — heavily compressed images often get rejected. A sharper photo is safer.",
    );
  }

  return { blockers, warnings };
}
