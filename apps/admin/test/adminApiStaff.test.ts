import { describe, expect, it, vi } from "vitest";
import { adminApi } from "../src/lib/adminApi";

describe("adminApi staff methods", () => {
  it("calls the staff routes with encoded usernames and auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ updated: true, disabled: true, enabled: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await adminApi.setStaffRole("token-1", "owner+rgs@example.com", "Finance");
    await adminApi.disableStaff("token-1", "owner+rgs@example.com");
    await adminApi.enableStaff("token-1", "owner+rgs@example.com");

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /\/api\/v1\/admin\/staff\/owner%2Brgs%40example\.com\/role$/,
      ),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ role: "Finance" }),
        headers: expect.objectContaining({ authorization: "Bearer token-1" }),
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /\/api\/v1\/admin\/staff\/owner%2Brgs%40example\.com\/disable$/,
      ),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(
        /\/api\/v1\/admin\/staff\/owner%2Brgs%40example\.com\/enable$/,
      ),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists and invites staff through the collection endpoint", async () => {
    const staffMember = {
      username: "ops-user",
      email: "ops@rgs.test",
      role: "Ops",
      status: "CONFIRMED",
      enabled: true,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([staffMember]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(staffMember), { status: 200 }),
      );

    await expect(adminApi.listStaff("token-2")).resolves.toEqual([staffMember]);
    await expect(
      adminApi.inviteStaff("token-2", {
        email: "ops@rgs.test",
        role: "Ops",
      }),
    ).resolves.toEqual(staffMember);

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/api\/v1\/admin\/staff$/),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/api\/v1\/admin\/staff$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "ops@rgs.test", role: "Ops" }),
      }),
    );
  });
});
