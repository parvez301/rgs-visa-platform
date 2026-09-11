import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { addLineItem } from "../../src/domain/crm/lineItems";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { writeCase } from "../../src/domain/crm/caseStore";
import { buildTestContext, type TestContext } from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedOneCase(context: TestContext) {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef: "60001",
      caseType: "VISA",
      visaType: "EVISA_TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    },
    ACTOR,
  );
}

describe("addLineItem", () => {
  it("appends the item and recomputes totalInr from every line, not by adding to the old total", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);

    const afterFirst = await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 2, unitPriceInr: 5000 },
      ACTOR,
    );
    expect(afterFirst.totalInr).toBe(10000);

    const afterSecond = await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "GOVT_FEE", quantity: 1, unitPriceInr: 1500 },
      ACTOR,
    );
    expect(afterSecond.lineItems).toHaveLength(2);
    expect(afterSecond.totalInr).toBe(11500);
  });

  it("stores amountInr as the unit price and multiplies by quantity for the total, rather than folding quantity into amountInr", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);

    const afterAdd = await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 3, unitPriceInr: 2000 },
      ACTOR,
    );

    // A quantity-of-1 case can't tell "amountInr x quantity" from "amountInr"
    // apart -- quantity 3 can. The stored line keeps the unit price (2000);
    // only the case total (6000) reflects the multiplication.
    expect(afterAdd.lineItems[0]?.amountInr).toBe(2000);
    expect(afterAdd.lineItems[0]?.quantity).toBe(3);
    expect(afterAdd.totalInr).toBe(6000);
  });

  it("refuses a code that is not in the catalog, as a 400 ApiError rather than a bare Error", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    await expect(
      addLineItem(
        context,
        TENANT_ID,
        seededCase.caseId,
        { lineItemCode: "MADE_UP", quantity: 1, unitPriceInr: 100 },
        ACTOR,
      ),
      // router.ts maps only ApiError subclasses, so the statusCode is what
      // actually determines whether a route answers 400 or a bare-Error 500
      // -- the message alone can't tell the two apart.
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("MADE_UP") });
  });

  it("rejects a quantity that fails LineItemSchema as a 400 ApiError, not an unhandled ZodError", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);

    // quantity: 0 clears the catalog-membership check (VISA_SERVICE_FEE is
    // real) and reaches the LineItemSchema.parse guard, where .int().positive()
    // rejects it. An unwrapped ZodError here is not an ApiError, and
    // router.ts maps only ApiError subclasses -- so this would otherwise
    // surface as a bare 500 instead of a 400 naming the problem.
    await expect(
      addLineItem(
        context,
        TENANT_ID,
        seededCase.caseId,
        { lineItemCode: "VISA_SERVICE_FEE", quantity: 0, unitPriceInr: 5000 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("records an auditable event naming the code, quantity, unit amount, and line total", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 3, unitPriceInr: 1000 },
      ACTOR,
    );

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    const lineItemEvents = events.filter((event) => event.eventType === "LINE_ITEM_ADDED");
    expect(lineItemEvents).toHaveLength(1);
    expect(lineItemEvents[0]?.actorEmail).toBe(ACTOR);
    // amountInr (unit price) and lineTotalInr (amountInr x quantity) are
    // asserted as distinct values on purpose: a quantity-3 line at 1000 each
    // moves the case total by 3000, and a reader of the event who sees only
    // amountInr: 1000 would have to multiply to know that.
    expect(lineItemEvents[0]?.meta).toMatchObject({
      lineItemCode: "VISA_SERVICE_FEE",
      quantity: 3,
      amountInr: 1000,
      lineTotalInr: 3000,
    });
  });

  it("recomputes totalInr from the full line-item list rather than incrementing an already-wrong stored total", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);

    // Force the stored totalInr to disagree with the one real line item it
    // sits next to (999 instead of the correct 500) -- something only a bug,
    // or (before this task) nothing at all, could produce. If addLineItem
    // ever added to currentCase.totalInr instead of recomputing from
    // lineItems, this stale 999 would leak into the result below.
    const caseWithStaleTotal: crm.CrmCase = {
      ...seededCase,
      lineItems: [
        {
          code: "GOVT_FEE",
          label: "Government / embassy fee",
          kind: "GOVT_FEE",
          amountInr: 500,
          quantity: 1,
        },
      ],
      totalInr: 999,
    };
    await writeCase(context, caseWithStaleTotal);

    const afterAdd = await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 2, unitPriceInr: 1000 },
      ACTOR,
    );

    // Correct: 500 (existing) + 1000 x 2 (new) = 2500. An incrementing
    // implementation would answer 999 + 2000 = 2999 instead.
    expect(afterAdd.lineItems).toHaveLength(2);
    expect(afterAdd.totalInr).toBe(2500);
  });
});
