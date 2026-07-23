# E2E staging happy path (manual checklist)

Run against staging after portal/admin are deployed (or locally with
`.env.local` pointed at staging API). Claude runs this at review time.

## Prerequisites

- [ ] Staging API healthy: `GET /api/v1/config/countries` returns catalog
- [ ] Portal reachable (local `:3200` or CloudFront `PortalUrl`)
- [ ] Admin reachable (local `:3300` or CloudFront `AdminUrl`)
- [ ] Test user can sign up / sign in on users pool
- [ ] Admin user exists on admins pool (see `docs/staging-environment.md`)

## User path

1. [ ] Open portal → Sign up (or sign in) with a fresh test email
2. [ ] Dashboard → **Start new application** → pick **United Arab Emirates**
3. [ ] Wizard opens at Travellers:
   - Add 1 traveller with valid passport dates
   - Confirm amber warning appears if expiry &lt; travel+6m (optional)
   - Continue
4. [ ] Docs step:
   - Upload dummy JPEG/PNG/PDF for every required slot (≤ 10 MB)
   - Confirm Continue stays disabled until all slots filled
   - Continue
5. [ ] Essentials:
   - Travel date (today or later), purpose Tourism, phone, address
   - Continue
6. [ ] Review:
   - Fee card shows govt + service + total INR (`en-IN`)
   - Note: "No payment now…"
   - Submit → full-screen confirmation with application id
   - **Track on dashboard**
7. [ ] Dashboard shows application as SUBMITTED with timeline

## Admin path

8. [ ] Sign in to admin (temporary password → new-password challenge if first login)
9. [ ] Queue → SUBMITTED tab shows the application; metrics tiles populate
10. [ ] Open detail:
    - Approve each document (or Reject one with reason to exercise re-upload)
    - Transition SUBMITTED → DOCS_VERIFIED → SENT_TO_IMMIGRATION → APPROVED → DELIVERED
      (only legal next buttons should appear)
    - Request payment → Mark paid
    - Add an internal note
11. [ ] Activity feed (7d) shows STATUS_CHANGED / DOC_REVIEWED events
12. [ ] Config page lists countries; edit one fee and Save → toast
    "Live immediately for new applications"

## Rejected-doc re-entry (optional but recommended)

13. [ ] From admin, Reject one document with a reason while status is SUBMITTED
14. [ ] User dashboard shows red chip **Action needed — re-upload document**
15. [ ] Chip opens wizard Docs in re-upload-only mode; re-upload succeeds;
      message "Done — our team will re-check"
16. [ ] Admin re-approves; user timeline advances normally

## Done when

All checked boxes above are green and no console/network errors block the flow.
