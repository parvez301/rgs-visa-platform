import { describe, expect, it } from "vitest";
import { createPartner } from "../src/domain/crm/partners";
import { buildTestContext } from "./helpers";

describe("buildTestContext", () => {
  it("migrates PGlite and writes a partner", async () => {
    const context = await buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels" },
      "desk@rgs.local",
    );
    expect(partner.partnerId).toMatch(/^prt_/);
    const listed = await context.sql.query<{ n: string }>(
      `select count(*)::text as n from crm_partners`,
    );
    expect(listed.rows[0]?.n).toBe("1");
    await context.sql.end();
  });
});
