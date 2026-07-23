# Review questions (Cursor → Claude)

## Admin document download

Task 8 left the per-document **View** button disabled with tooltip
`download in review build`.

`GET /api/v1/admin/applications/{id}` returns documents with `s3Key`, but there
is no admin presigned-download route today. Adding one would change the API
contract — please confirm whether we should:

1. Add `GET /api/v1/admin/applications/{id}/documents/download?docType=&travellerIndex=`, or
2. Reuse the user download route with admin JWT, or
3. Something else.

Until then admins can only Approve/Reject without previewing the file.

## Infra typecheck

Resolved in Task 13 by adding `@types/node` as an infra devDependency so
`cdk synth` / `tsc --noEmit` work.
