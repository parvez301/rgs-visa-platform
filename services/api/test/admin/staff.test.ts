import { describe, expect, it } from "vitest";
import {
  disableStaff,
  enableStaff,
  inviteStaff,
  listStaff,
  setStaffRole,
} from "../../src/domain/admin/staff";
import { InMemoryCognitoAdmins } from "../../src/lib/cognitoAdmins";
import { ApiError } from "../../src/lib/errors";

describe("Cognito staff domain", () => {
  it("invites a staff member and assigns the requested role group", async () => {
    const client = new InMemoryCognitoAdmins();

    const invited = await inviteStaff(
      client,
      { email: "new.admin@example.com", role: "Ops" },
      "owner@example.com",
    );

    expect(invited).toEqual({
      username: "new.admin@example.com",
      email: "new.admin@example.com",
      role: "Ops",
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
    });
    expect(await client.adminListGroupsForUser("new.admin@example.com")).toEqual(["Ops"]);
  });

  it("rejects an invite when the email already exists", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("existing@example.com", ["Viewer"]),
    ]);

    await expectApiError(
      inviteStaff(
        client,
        { email: "existing@example.com", role: "Ops" },
        "owner@example.com",
      ),
      409,
    );
  });

  it("changes role by removing all other admin role groups", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("staff@example.com", ["Owner", "Ops", "unrelated"]),
      staffUser("other-owner@example.com", ["Owner"]),
    ]);

    await setStaffRole(client, "staff@example.com", "Finance", "other-owner@example.com");

    expect(await client.adminListGroupsForUser("staff@example.com")).toEqual([
      "unrelated",
      "Finance",
    ]);
  });

  it("leaves no admin role when adding the replacement role fails", async () => {
    const client = new FaultInjectingCognitoAdmins(
      [
        staffUser("staff@example.com", ["Ops", "Viewer", "unrelated"]),
      ],
      { failAddGroup: "Finance" },
    );

    await expect(
      setStaffRole(client, "staff@example.com", "Finance", "owner@example.com"),
    ).rejects.toThrow("Injected add failure");

    expect(await client.adminListGroupsForUser("staff@example.com")).toEqual([
      "unrelated",
    ]);
  });

  it("does not add the replacement role when removing an old role fails", async () => {
    const client = new FaultInjectingCognitoAdmins(
      [
        staffUser("staff@example.com", ["Ops", "Viewer", "unrelated"]),
      ],
      { failRemoveGroup: "Viewer" },
    );

    await expect(
      setStaffRole(client, "staff@example.com", "Finance", "owner@example.com"),
    ).rejects.toThrow("Injected remove failure");

    expect(await client.adminListGroupsForUser("staff@example.com")).toEqual([
      "Viewer",
      "unrelated",
    ]);
  });

  it("rejects disabling the actor's own account", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("owner@example.com", ["Owner"]),
    ]);

    await expectApiError(
      disableStaff(client, "owner@example.com", "owner@example.com"),
      400,
    );
  });

  it("rejects demoting the last enabled Owner", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("owner@example.com", ["Owner"]),
      staffUser("disabled-owner@example.com", ["Owner"], false),
    ]);

    await expectApiError(
      setStaffRole(client, "owner@example.com", "Ops", "someone@example.com"),
      400,
    );
    expect(await client.adminListGroupsForUser("owner@example.com")).toEqual(["Owner"]);
  });

  it("rejects disabling the last enabled Owner", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("owner@example.com", ["Owner"]),
      staffUser("viewer@example.com", ["Viewer"]),
    ]);

    await expectApiError(
      disableStaff(client, "owner@example.com", "someone@example.com"),
      400,
    );
    expect((await client.adminGetUser("owner@example.com")).enabled).toBe(true);
  });

  it("allows an Owner change when another enabled primary Owner remains", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("owner@example.com", ["Owner"]),
      staffUser("other-owner@example.com", ["Owner", "Ops"]),
    ]);

    await setStaffRole(client, "owner@example.com", "Viewer", "other-owner@example.com");

    expect(await client.adminListGroupsForUser("owner@example.com")).toEqual(["Viewer"]);
  });

  it("lists role-less users fail-closed with a null role", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("staff@example.com", ["unknown"]),
    ]);

    await expect(listStaff(client)).resolves.toEqual([
      {
        username: "staff@example.com",
        email: "staff@example.com",
        role: null,
        status: "CONFIRMED",
        enabled: true,
      },
    ]);
  });

  it("enables a disabled staff member", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("staff@example.com", ["Viewer"], false),
    ]);

    await enableStaff(client, "staff@example.com");

    expect((await client.adminGetUser("staff@example.com")).enabled).toBe(true);
  });
});

function staffUser(
  email: string,
  groups: string[],
  enabled = true,
): {
  username: string;
  email: string;
  groups: string[];
  status: string;
  enabled: boolean;
} {
  return {
    username: email,
    email,
    groups,
    status: "CONFIRMED",
    enabled,
  };
}

async function expectApiError(
  action: Promise<unknown>,
  statusCode: number,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(statusCode);
  }
}

class FaultInjectingCognitoAdmins extends InMemoryCognitoAdmins {
  constructor(
    seedUsers: ConstructorParameters<typeof InMemoryCognitoAdmins>[0],
    private readonly failures: {
      failAddGroup?: string;
      failRemoveGroup?: string;
    },
  ) {
    super(seedUsers);
  }

  override async adminAddUserToGroup(
    username: string,
    group: string,
  ): Promise<void> {
    if (group === this.failures.failAddGroup) {
      throw new Error("Injected add failure");
    }
    await super.adminAddUserToGroup(username, group);
  }

  override async adminRemoveUserFromGroup(
    username: string,
    group: string,
  ): Promise<void> {
    if (group === this.failures.failRemoveGroup) {
      throw new Error("Injected remove failure");
    }
    await super.adminRemoveUserFromGroup(username, group);
  }
}
