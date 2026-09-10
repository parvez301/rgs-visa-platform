import { describe, expect, it } from "vitest";
import { readTrustLevel, readUserPrefs, recordConfirmedWithoutEdit, setUserPrefs } from "../../src/agent/prefs";
import { crmUserPrefsPartitionKey, CRM_USER_PREFS_SORT_KEY } from "../../src/domain/crm/keys";
import { buildTestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

describe("readTrustLevel", () => {
  it("returns 0 for a user with no stored PREFS row -- a new user gets the safest behaviour", async () => {
    const context = buildTestContext();
    await expect(readTrustLevel(context, TENANT_ID, ACTOR)).resolves.toBe(0);
  });

  // Moves the stored value off its schema default (0) before asserting
  // against it -- a production implementation that ignored the table and
  // always returned 0 would still pass the "absent" test above, so this is
  // the one that actually proves readTrustLevel reads the row.
  it("returns the trustLevel actually stored, once one exists", async () => {
    const context = buildTestContext();
    await setUserPrefs(context, TENANT_ID, ACTOR, { trustLevel: 2 });
    await expect(readTrustLevel(context, TENANT_ID, ACTOR)).resolves.toBe(2);
  });

  it("keeps two users' trust levels apart", async () => {
    const context = buildTestContext();
    await setUserPrefs(context, TENANT_ID, ACTOR, { trustLevel: 1 });
    await expect(readTrustLevel(context, TENANT_ID, "other@rgs.local")).resolves.toBe(0);
  });
});

describe("readUserPrefs", () => {
  it("hands back the full schema-defaulted row for a first-time user, not just trustLevel", async () => {
    const context = buildTestContext();
    await expect(readUserPrefs(context, TENANT_ID, ACTOR)).resolves.toEqual({
      tenantId: TENANT_ID,
      email: ACTOR,
      trustLevel: 0,
      autoApplyOptIn: false,
      defaultFilters: {},
      confirmedWithoutEditCount: 0,
    });
  });
});

describe("setUserPrefs", () => {
  it("stores a real row a later read can recover, under the key the brief specifies", async () => {
    const context = buildTestContext();
    await setUserPrefs(context, TENANT_ID, ACTOR, { trustLevel: 2, autoApplyOptIn: true });

    const storedItem = await context.table.get(crmUserPrefsPartitionKey(TENANT_ID, ACTOR), CRM_USER_PREFS_SORT_KEY);
    expect(storedItem).toMatchObject({ trustLevel: 2, autoApplyOptIn: true, email: ACTOR });
  });

  it("merges onto the existing row instead of replacing it", async () => {
    const context = buildTestContext();
    await setUserPrefs(context, TENANT_ID, ACTOR, { trustLevel: 2, autoApplyOptIn: true });
    await setUserPrefs(context, TENANT_ID, ACTOR, { trustLevel: 1 });

    const userPrefs = await readUserPrefs(context, TENANT_ID, ACTOR);
    // trustLevel was overwritten by the second call; autoApplyOptIn from the
    // first call survives because the second call never mentioned it.
    expect(userPrefs.trustLevel).toBe(1);
    expect(userPrefs.autoApplyOptIn).toBe(true);
  });
});

describe("recordConfirmedWithoutEdit", () => {
  it("starts a fresh user's counter at 1, not merely non-zero", async () => {
    const context = buildTestContext();
    await recordConfirmedWithoutEdit(context, TENANT_ID, ACTOR);
    const userPrefs = await readUserPrefs(context, TENANT_ID, ACTOR);
    expect(userPrefs.confirmedWithoutEditCount).toBe(1);
  });

  it("increments an existing count rather than resetting it", async () => {
    const context = buildTestContext();
    await setUserPrefs(context, TENANT_ID, ACTOR, { confirmedWithoutEditCount: 4 });
    await recordConfirmedWithoutEdit(context, TENANT_ID, ACTOR);
    const userPrefs = await readUserPrefs(context, TENANT_ID, ACTOR);
    expect(userPrefs.confirmedWithoutEditCount).toBe(5);
  });

  // task-10-controller-notes.md §6: advancement by confirmed-without-edit
  // count PROPOSES level 2, it never silently switches it on. Crossing
  // whatever threshold a future screen might use must not, on its own,
  // change trustLevel -- there is no threshold logic in this task at all.
  it("never moves trustLevel or autoApplyOptIn no matter how high the count climbs", async () => {
    const context = buildTestContext();
    for (let confirmation = 0; confirmation < 25; confirmation += 1) {
      await recordConfirmedWithoutEdit(context, TENANT_ID, ACTOR);
    }
    const userPrefs = await readUserPrefs(context, TENANT_ID, ACTOR);
    expect(userPrefs.confirmedWithoutEditCount).toBe(25);
    expect(userPrefs.trustLevel).toBe(0);
    expect(userPrefs.autoApplyOptIn).toBe(false);
  });
});
