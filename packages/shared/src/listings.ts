/**
 * Reading a listing endpoint that names the rows it could not read.
 *
 * Every collection endpoint in `services/api` answers
 * `{ <records>, unreadable<Record>Ids }` rather than a bare array, so that one
 * malformed stored row is skipped and NAMED instead of 500ing the whole
 * listing (finding C3). Two of those endpoints are unauthenticated and are
 * read by the marketing site, which is a statically built bundle deployed on
 * its own schedule — so there is a window in which a browser running the old
 * bundle talks to the new API, or the reverse.
 *
 * `unwrapListingResponse` closes that window from the client side. It accepts
 * the wrapper, and it accepts a bare array from an API that has not been
 * deployed yet, and it refuses to throw on anything else. The alternative is
 * what the previous round shipped: `payload.unreadableIds.length` on a payload
 * that is still an array, which is a TypeError that takes the page down —
 * turning a defensive change into an outage of exactly the kind it was made to
 * prevent.
 */
export interface UnwrappedListing<RecordType> {
  records: RecordType[];
  /** Ids the API skipped. Always an array, even against an old API. */
  unreadableRecordIds: string[];
}

export function unwrapListingResponse<RecordType>(
  responsePayload: unknown,
  recordsFieldName: string,
  unreadableIdsFieldName: string,
): UnwrappedListing<RecordType> {
  // An API deployed before the wrapper existed: the payload IS the list.
  if (Array.isArray(responsePayload)) {
    return { records: responsePayload as RecordType[], unreadableRecordIds: [] };
  }
  if (responsePayload === null || typeof responsePayload !== "object") {
    return { records: [], unreadableRecordIds: [] };
  }
  const payloadFields = responsePayload as Record<string, unknown>;
  const recordsField = payloadFields[recordsFieldName];
  const unreadableIdsField = payloadFields[unreadableIdsFieldName];
  return {
    records: Array.isArray(recordsField) ? (recordsField as RecordType[]) : [],
    unreadableRecordIds: Array.isArray(unreadableIdsField)
      ? unreadableIdsField.filter(
          (unreadableId): unreadableId is string => typeof unreadableId === "string",
        )
      : [],
  };
}
