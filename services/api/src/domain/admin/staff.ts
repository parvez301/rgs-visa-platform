import { randomBytes } from "node:crypto";
import { ADMIN_ROLES, primaryRole, type AdminRole } from "@rgs/shared";
import type {
  CognitoAdminsClient,
  CognitoAdminUser,
} from "../../lib/cognitoAdmins";
import type { EmailSender } from "../../lib/email";
import { badRequest, conflict } from "../../lib/errors";

export interface StaffMember {
  username: string;
  email: string;
  role: AdminRole | null;
  status: string;
  enabled: boolean;
}

export interface StaffInviteMail {
  email: EmailSender;
  loginUrl: string;
  generateTemporaryPassword?: () => string;
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
  mail: StaffInviteMail,
): Promise<StaffMember> {
  void actorEmail;
  const temporaryPassword =
    mail.generateTemporaryPassword?.() ?? generateTemporaryPassword();
  let user: CognitoAdminUser;
  try {
    user = await client.adminCreateUser({
      email: input.email,
      temporaryPassword,
    });
  } catch (error) {
    if (hasErrorName(error, "UsernameExistsException")) {
      throw conflict(`A staff member with email ${input.email} already exists`);
    }
    throw error;
  }
  await client.adminAddUserToGroup(user.username, input.role);
  await sendStaffInviteEmail(mail, user.email, temporaryPassword);
  return toStaffMember(client, user);
}

/**
 * Re-issues a temporary password for staff stuck in FORCE_CHANGE_PASSWORD
 * (Cognito invite never arrived) and emails it via SES.
 */
export async function resendStaffInvite(
  client: CognitoAdminsClient,
  username: string,
  mail: StaffInviteMail,
): Promise<StaffMember> {
  const user = await client.adminGetUser(username);
  if (user.status !== "FORCE_CHANGE_PASSWORD") {
    throw badRequest(
      "Resend is only available while the staff member still needs to set their first password",
    );
  }
  const temporaryPassword =
    mail.generateTemporaryPassword?.() ?? generateTemporaryPassword();
  await client.adminSetUserPassword({
    username,
    password: temporaryPassword,
    permanent: false,
  });
  await sendStaffInviteEmail(mail, user.email, temporaryPassword);
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

  for (const existingRole of ADMIN_ROLES) {
    if (existingRole !== role && groups.includes(existingRole)) {
      await client.adminRemoveUserFromGroup(username, existingRole);
    }
  }
  await client.adminAddUserToGroup(username, role);
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

/** Cognito admins pool: min 10 chars, lowercase + digits required. */
export function generateTemporaryPassword(): string {
  const alphabet =
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  const bytes = randomBytes(16);
  let password = "";
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length]!;
  }
  // Guarantee policy characters even if random draw missed them.
  return `a1${password}`.slice(0, 14);
}

async function sendStaffInviteEmail(
  mail: StaffInviteMail,
  toAddress: string,
  temporaryPassword: string,
): Promise<void> {
  await mail.email.send({
    toAddress,
    subject: "Your RGS CRM login (temporary password)",
    bodyText: [
      "You have been invited to the Rays Global Services CRM.",
      "",
      `Sign in: ${mail.loginUrl}`,
      `Email: ${toAddress}`,
      `Temporary password: ${temporaryPassword}`,
      "",
      "You will be asked to choose a new password on first sign-in.",
      "If you did not expect this email, contact your CRM owner.",
    ].join("\n"),
  });
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
