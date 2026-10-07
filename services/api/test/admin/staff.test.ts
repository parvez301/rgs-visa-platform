import { describe, expect, it } from "vitest";
import {
  disableStaff,
  enableStaff,
  inviteStaff,
  listStaff,
  resendStaffInvite,
  setStaffRole,
} from "../../src/domain/admin/staff";
import { InMemoryCognitoAdmins } from "../../src/lib/cognitoAdmins";
import { InMemoryEmailSender } from "../../src/lib/email";
import { ApiError } from "../../src/lib/errors";

const LOGIN_URL = "https://crm.raysglobalservices.com";

function mailDeps(email = new InMemoryEmailSender()) {
  return { email, loginUrl: LOGIN_URL, generateTemporaryPassword: () => "TempPass12ab" };
}

describe("Cognito staff domain", () => {
  it("invites a staff member, assigns the role, and emails the temp password via SES", async () => {
    const client = new InMemoryCognitoAdmins();
    const email = new InMemoryEmailSender();

    const invited = await inviteStaff(
      client,
      { email: "new.admin@example.com", role: "Ops" },
      "owner@example.com",
      mailDeps(email),
    );

    expect(invited).toEqual({
      username: "new.admin@example.com",
      email: "new.admin@example.com",
      role: "Ops",
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
    });
    expect(await client.adminListGroupsForUser("new.admin@example.com")).toEqual(["Ops"]);
    expect(email.sentEmails).toHaveLength(1);
    expect(email.sentEmails[0]).toMatchObject({
      toAddress: "new.admin@example.com",
      subject: expect.stringContaining("CRM login"),
    });
    expect(email.sentEmails[0]?.bodyText).toContain("TempPass12ab");
    expect(email.sentEmails[0]?.bodyText).toContain(LOGIN_URL);
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
        mailDeps(),
      ),
      409,
    );
  });

  it("resends a temporary password email for FORCE_CHANGE_PASSWORD staff", async () => {
    const client = new InMemoryCognitoAdmins([
      {
        username: "stuck@example.com",
        email: "stuck@example.com",
        groups: ["Ops"],
        status: "FORCE_CHANGE_PASSWORD",
        enabled: true,
      },
    ]);
    const email = new InMemoryEmailSender();

    const resent = await resendStaffInvite(client, "stuck@example.com", mailDeps(email));

    expect(resent.status).toBe("FORCE_CHANGE_PASSWORD");
    expect(email.sentEmails).toHaveLength(1);
    expect(email.sentEmails[0]?.toAddress).toBe("stuck@example.com");
    expect(email.sentEmails[0]?.bodyText).toContain("TempPass12ab");
  });

  it("rejects resend when the staff member is already confirmed", async () => {
    const client = new InMemoryCognitoAdmins([
      staffUser("done@example.com", ["Ops"]),
    ]);

    await expectApiError(resendStaffInvite(client, "done@example.com", mailDeps()), 400);
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
