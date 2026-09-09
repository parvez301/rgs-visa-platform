import { describe, expect, it } from "vitest";
import { unwrapListingResponse } from "../src/listings";

interface StubNotice {
  noticeId: string;
}

describe("unwrapListingResponse", () => {
  it("unwraps the listing shape the API now answers with", () => {
    const unwrapped = unwrapListingResponse<StubNotice>(
      { notices: [{ noticeId: "ntc_1" }], unreadableNoticeIds: ["ntc_bad"] },
      "notices",
      "unreadableNoticeIds",
    );
    expect(unwrapped.records).toEqual([{ noticeId: "ntc_1" }]);
    expect(unwrapped.unreadableRecordIds).toEqual(["ntc_bad"]);
  });

  // The whole reason this function exists rather than `payload.notices`. The
  // marketing site is a static bundle deployed on its own schedule, so a
  // browser can run the new bundle against an API that still answers a bare
  // array -- or the reverse. `payload.unreadableNoticeIds.length` on an array
  // is a TypeError, which takes the page down: an outage caused by the change
  // that was made to prevent one.
  it("accepts a bare array from an API deployed before the wrapper", () => {
    const unwrapped = unwrapListingResponse<StubNotice>(
      [{ noticeId: "ntc_1" }, { noticeId: "ntc_2" }],
      "notices",
      "unreadableNoticeIds",
    );
    expect(unwrapped.records).toHaveLength(2);
    expect(unwrapped.unreadableRecordIds).toEqual([]);
  });

  it("answers empty rather than throwing on a payload of the wrong shape", () => {
    for (const brokenPayload of [null, undefined, "not json", 42, {}]) {
      const unwrapped = unwrapListingResponse<StubNotice>(
        brokenPayload,
        "notices",
        "unreadableNoticeIds",
      );
      expect(unwrapped.records).toEqual([]);
      expect(unwrapped.unreadableRecordIds).toEqual([]);
    }
  });

  it("ignores a non-array records field instead of handing back a non-list", () => {
    const unwrapped = unwrapListingResponse<StubNotice>(
      { notices: { noticeId: "ntc_1" }, unreadableNoticeIds: "ntc_bad" },
      "notices",
      "unreadableNoticeIds",
    );
    expect(unwrapped.records).toEqual([]);
    expect(unwrapped.unreadableRecordIds).toEqual([]);
  });

  it("drops non-string ids so a caller can always join() the list", () => {
    const unwrapped = unwrapListingResponse<StubNotice>(
      { notices: [], unreadableNoticeIds: ["ntc_bad", 7, null, "ntc_worse"] },
      "notices",
      "unreadableNoticeIds",
    );
    expect(unwrapped.unreadableRecordIds).toEqual(["ntc_bad", "ntc_worse"]);
  });
});
