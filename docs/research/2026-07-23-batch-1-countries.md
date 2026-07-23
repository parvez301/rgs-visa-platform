# Country catalog — research batch 1 (2026-07-23)

26 top Indian-outbound destinations seeded into the shared catalog
(`RESEARCH_BATCH_1` in `packages/shared/src/countryProducts.ts`).

**Provenance policy:** facts only (visa scheme, official fee, validity/stay,
processing window) from official government sources — the `officialUrl` on each
entry. All page copy is original RGS copy (hand-written for launch countries,
template-generated from facts otherwise). Nothing is copied from competitor
sites.

**Safety gates:**
1. Every entry seeded `active: false` + `tier: INFO_ONLY` — nothing shows
   publicly until the owner reviews it in admin Config.
2. Fees converted at ~₹84/USD from official fee schedules as known at research
   date — OWNER MUST VERIFY each fee and current policy before activating
   (visa-free schemes for Indians, e.g. Thailand/Malaysia/Sri Lanka, are
   time-limited policies that change).
3. To make a country applyable end-to-end: set a service fee, add the docs
   checklist, switch tier to FULFILLED, then activate. Marketing site needs a
   rebuild+deploy to grow its static country pages (fees hydrate live, page
   existence does not).

Batch: SG TH MY VN ID LK NP MV KH PH JP KR CN HK TR GE AM AZ EG KE US GB FR DE IT NL.
Notable flags: TH/MY/NP visa-free (policy-dependent); LK free ETA; MV/ID visa on
arrival; HK pre-arrival registration; US/GB/Schengen/JP/KR/CN assisted sticker
visas — high-value RGS fulfilment candidates.

Next batches (owner to prioritise): Gulf (SA OM QA BH KW JO), rest of Schengen,
Africa (ET RW MA MU SC), Americas (BR MX AR), CIS (KZ UZ KG).
