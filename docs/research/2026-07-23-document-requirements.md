# Document checklist research — India-origin applicants (2026-07-23)

Why: initial catalog checklists were estimates. This pass verified them against
Atlys (where reachable) and official/secondary sources. Note: Atlys geo-locks
content by IP — from a UAE IP their lists show UAE-resident documents (Emirates
ID), which do NOT apply to RGS's India-origin market. India-specific lists below.

| Country | Verified checklist (tourist) | Sources / notes |
|---|---|---|
| AE | Passport bio, photo | Atlys en-IN Dubai page: "2 steps — passport + photo". Fee card ₹6.5k govt + fee split observed on atlys.com |
| AU (600) | Passport, photo, bank statements (consistent history, no fund-parking), ITR, employment proof | Home Affairs checklist via nationwidevisas/travelbooksfood guides; flights NOT to be booked pre-grant |
| CA (TRV) | Passport, photo, bank statements, ITR, employment proof | IRCC standard visitor file for Indian applicants |
| NZ | Passport, photo, bank statements, employment proof | INZ funds + ties evidence |
| TZ | Passport, photo, flight booking, hotel booking | visit-tz/visago: $50 fee, 5–10 working days, 90-day stay |
| UG | Passport, photo, **yellow fever certificate (mandatory)**, return ticket | immigration.go.ug + uganda-evisa.com; decision 2–3 days; photo 500×500 white bg |
| NG | Passport (6mo validity, 2 blank pages), photo (35×45mm), flight booking, hotel/invitation, bank statement (proof of funds) | immigration.gov.ng FAQ; e-Visa ≈ **USD 253 (~₹21.5k)** — govt fee seed updated from ₹8.5k; approval 24–48h |
| ZM | Passport, photo, return ticket, hotel proof, cover letter to Director General of Immigration | zambia-visa.com/itzeazy; 5–7 day processing |

Catalog changes applied in `packages/shared/src/countryProducts.ts`:
- New doc types: `YELLOW_FEVER_CERT`, `ITR`, `EMPLOYMENT_PROOF`, `COVER_LETTER`.
- AU/CA: swapped FLIGHT_ITINERARY for ITR + EMPLOYMENT_PROOF.
- NG govt fee ₹8,500 → ₹21,500; processing 10 → 5 working days.
- UG processing 5 → 3; ZM 5 → 7.

Still owner-review before launch: RGS's own service fees, and whether RGS's
channel partners change any govt fee (e.g. UAE partner rates).
