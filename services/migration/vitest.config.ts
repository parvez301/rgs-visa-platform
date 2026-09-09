import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      /**
       * The workbook's date cells arrive as midnight UTC, and the reader renders
       * them with toISOString(). A getFullYear/getMonth/getDate implementation
       * shifts every one of them back a day — but ONLY in a negative-offset
       * zone. Measured: with local getters the suite is 25/25 green on this
       * machine (GMT+0400) and 6 red under America/New_York.
       *
       * So the suite pins a negative-offset zone. Without this the UTC guards in
       * readWorkbook.test.ts cannot fail here or on a UTC CI runner, which makes
       * them decoration rather than tests.
       */
      TZ: "America/New_York",
    },
  },
});
