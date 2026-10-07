# Country config master sheet

Source: live prod catalog exported **2026-10-07** from
`GET /api/v1/config/countries` (API `blmrzykq5a`).

## Files

| File | Use |
|---|---|
| `country-config-fee-master.xlsx` | **Office working file.** Yellow columns = edit fees. Armenia mistaken `15000` service fee already corrected to `1500` in proposed/import. |
| `country-config-prod-export.csv` | Raw prod snapshot (includes helper `totalFeeInr`). Keep as audit copy. |
| `country-config-import-ready.csv` | Ready for CRM **Import CSV** (Armenia service fee fixed to `1500`; other countries = current prod). |

## How pricing works

- CRM Config stores **two** fields: `governmentFeeInr` + `serviceFeeInr`.
- Marketing shows their **sum** (no separate “total price” field).
- Save / CSV Import → prod API → marketing refreshes on next page load (no rebuild for fees).

## Flagged on export

- **Armenia (`AM`)**: service fee = `15000` (total `17600`). Likely a mistaken edit meant for Australia. Fix in the sheet before Import.

## Office workflow

1. Edit `governmentFeeInr` and `serviceFeeInr` for every country to the real split.
2. Check `totalFeeInr` in the working sheet equals what customers should see.
3. When ready: open https://crm.raysglobalservices.com → **Config** → **Import CSV** → choose `country-config-import-ready.csv` (after edits) → preview → save.
4. Hard-refresh https://marketing.raysglobalservices.com/ and spot-check several destinations.

Do **not** change `productCode` unless you know why — that is the stable key.
