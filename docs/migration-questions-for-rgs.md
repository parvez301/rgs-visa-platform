# Questions for RGS before the Excel sheet becomes the CRM

Every number below was measured by running the importer over the live workbook
(`CRM - RAYS GLOBAL SERVICES.xlsx`, 7,156 rows). Nothing here is a guess about
your data — it is what your sheet actually contains.

**How to use this:** each question has a **default**. If you say nothing, the
default happens and the affected rows land in the CRM's review queue, where they
can be fixed later without re-importing. Answering now just saves that work.

---

## 1. Three referrer names we can't place — 644 rows

The REFRENCE column has three values that don't match any agency in the list:

| Name | Rows |
|---|---|
| `MEHUL MEHUL` | 456 |
| `MEHUL MANOJ` | 110 |
| `SAMMY A/C` | 78 |

**Question:** are these three separate agencies, one agency written three ways, or
staff members rather than referrers?

**Default:** each becomes its own partner record under that exact name.

---

## 2. The Country column is doing two jobs — 225 rows, 63 different values

Some rows have a service in the Country column instead of a destination:

`PASSPORT NEW` 34 · `TRAVEL INSURANCE` 21 · `USA DROP OFF` 15 ·
`PASSPORT RENEWAL` 9 · `EUISA` 9 · `APPOSTILLE` 6 · `AIRTICKET` 5 ·
`PCC+MARKSHEEI` 3

**Question:** are these separate service lines you sell — passport renewals,
travel insurance, apostille, air tickets — that should be their own case type in
the CRM, rather than being filed as a destination country?

Three other patterns in the same column, all needing a rule:

- **Misspellings** — as of this build, two of these already correct
  automatically, because each has exactly one unambiguous real-country match:
  `Myannmar` 13 rows → Myanmar, `Lexumbourg` 7 rows → Luxembourg. The rest stay
  unresolved and go to review, by default, because we are not guessing without
  you confirming: `COMBODIA` 4, `AFGANISTAN` 2, `MAALI` 2, `KRGYZ` 2,
  `USA DROPOJ` 3 (13 rows). The rule: an unambiguous, single-candidate
  misspelling resolves the way a desk agent reading it would; anything with
  more than one plausible reading stays a question for you. Say the word if
  you want any of the remaining five corrected too.
- **Multi-country trips** — `TANZANIA/KENYA`, `Nigeria / GHANA`, `EGYPT & JORDAN`,
  `FRANCE/UK`, `KENYA/ZAMBIA`, `zambia mozambique malawi`, `OMAN/EGYPT`.
  Should one case carry several destinations?
- **Not a country** — `JAIPUR` 2 (a city), `CANTON` 4, `QNLWE` 3, `3E` 1.

**Default:** the row imports with no destination set and raises one review item
per distinct value — so 63 decisions, not 225 (down from 245/65 now that
Myannmar and Lexumbourg resolve on their own).

---

## 3. Dates that can't be read — 102 rows

Two different problems, and only the second needs you:

**Typing slips** (we can fix these mechanically once you confirm):
`24-02-026` 17 rows · `10//10/2025` 6 · `22-012024` 5 · `28/102025` ·
`21/4//2025` · `07-04-202507-04-2025`

**Dates that look deliberate but are impossible or far in the future.**
The Sub Date column contains a run of `26/6/2028`, `26/6/2029`, `26/6/2030` …
through `26/6/2035`, and the received-date column contains `31-01-2028`,
`31-01-2029`, `31-01-2030` ×3. It also holds two 2006 dates (`04-05-2006`,
`12-05-2006`) that look like dates of birth.

**Question:** is someone recording a visa's *expiry* in the submission-date
column? If so, the CRM should have a proper expiry field rather than us
discarding these.

Also impossible as written: `26/23/2025` (month 23), `31/11/2025` (November has
30 days), `29/02/2026` (2026 isn't a leap year), `38/6/2026`, `3/66/2026`.
And three with no year at all: `12/5`, `27/5`, `8/5`.

**Default:** the date is left blank, the original text is kept on the record, and
the row goes to review.

---

## 4. Notes sitting in the wrong column — 34 rows

Values that landed one column over from where they belong:
`Evisa` 20 · `N/A` 4 · `REJECT`/`reject`/`rejcted`/`REJECTED` 4 ·
`travel@airbournetravels.com` 1 · `DUPLICATE` 1 · `aposttile` 1

**Question:** the four spellings of "rejected" — is that an outcome the CRM should
record on the application, separate from its status?

**Default:** kept as a note on the case, flagged for review.

---

## 5. The same REF NO. used twice — 18 refs, 36 rows

18 reference numbers appear on two different rows. **14 of those pairs are two
different referrers and usually two different countries** — e.g. ref `32669` is
PARADISE TOURS / Kenya on one row and Ozzy Travels / Japan on another. Only 2 are
the same traveller entered twice.

**Question:** is a REF NO. meant to be unique per case? If yes, these 18 are data
entry collisions and should be renumbered.

**Default:** the first row keeps the plain number, the second gets a suffix, both
are flagged. No row is lost and no traveller is moved to the wrong agency.

---

## 6. 207 rows with no referrer at all

**Question:** are these walk-in customers who came to you directly, or is the
referrer just missing?

**Default:** they are attached to a placeholder called *(no referrer recorded)* —
deliberately not "direct", because a blank cell doesn't claim that.

---

## 7. Four cases with no applicant count — 4 rows

The `No.` column holds `0` on three rows and `2 DOC` on one.

**Question:** should a blank or zero mean one applicant?

**Default:** the case imports with no applicants and is flagged, rather than us
inventing a traveller who may not exist.

---

## What happens either way

Every one of the 7,156 rows imports. Nothing is dropped and nothing is silently
changed — every uncertain value is preserved exactly as typed and raised in the
review queue, which groups by distinct value, so 644 partner rows are 3 decisions
and 225 country rows are 63 (Myannmar and Lexumbourg, 20 rows across 2 values,
already resolve on their own and are not in that count).

The import is re-runnable against the live sheet: running it again adds only what
is new.
