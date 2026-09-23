import { ADMIN_ROLES, primaryRole, type AdminRole } from "@rgs/shared";
import type {
  CognitoAdminsClient,
  CognitoAdminUser,
} from "../../lib/cognitoAdmins";
import { badRequest, conflict } from "../../lib/errors";

export interface StaffMember {
  username: string;
  email: string;
  role: AdminRole | null;
  status: string;
  enabled: boolean;
}

export async function listStaff(
  client: CognitoAdminsClient,
): Promise<StaffMember[]> {
  const users = await client.listUsers();
  return Promise.all(users.map((user) => toStaffMember(client, user)));
}

export async function inviteStaff(
  client: CognitoAdminsClient,
  input: { email: string; role: AdminRole },
  actorEmail: string,
): Promise<StaffMember> {
  void actorEmail;
  let user: CognitoAdminUser;
  try {
    user = await client.adminCreateUser({ email: input.email });
  } catch (error) {
    if (hasErrorName(error, "UsernameExistsException")) {
      throw conflict(`A staff member with email ${input.email} already exists`);
    }
    throw error;
  }
  await client.adminAddUserToGroup(user.username, input.role);
  return toStaffMember(client, user);
}

export async function setStaffRole(
  client: CognitoAdminsClient,
  username: string,
  role: AdminRole,
  actorUsername: string,
): Promise<void> {
  void actorUsername;
  const groups = await client.adminListGroupsForUser(username);
  if (primaryRole(groups) === "Owner" && role !== "Owner") {
    await requireAnotherEnabledOwner(client, username);
  }

  await client.adminAddUserToGroup(username, role);
  for (const existingRole of ADMIN_ROLES) {
    if (existingRole !== role && groups.includes(existingRole)) {
      await client.adminRemoveUserFromGroup(username, existingRole);
    }
  }
}

export async function disableStaff(
  client: CognitoAdminsClient,
  username: string,
  actorUsername: string,
): Promise<void> {
  if (username === actorUsername) {
    throw badRequest("You cannot disable your own staff account");
  }
  const groups = await client.adminListGroupsForUser(username);
  if (primaryRole(groups) === "Owner") {
    await requireAnotherEnabledOwner(client, username);
  }
  await client.adminDisableUser(username);
}

export async function enableStaff(
  client: CognitoAdminsClient,
  username: string,
): Promise<void> {
  await client.adminEnableUser(username);
}

async function toStaffMember(
  client: CognitoAdminsClient,
  user: CognitoAdminUser,
): Promise<StaffMember> {
  const groups = await client.adminListGroupsForUser(user.username);
  return {
    username: user.username,
    email: user.email,
    role: primaryRole(groups),
    status: user.status,
    enabled: user.enabled,
  };
}

async function requireAnotherEnabledOwner(
  client: CognitoAdminsClient,
  excludedUsername: string,
): Promise<void> {
  const users = await client.listUsers();
  for (const user of users) {
    if (!user.enabled || user.username === excludedUsername) {
      continue;
    }
    const groups = await client.adminListGroupsForUser(user.username);
    if (primaryRole(groups) === "Owner") {
      return;
    }
  }
  throw badRequest("The last enabled Owner cannot be demoted or disabled");
}

function hasErrorName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
