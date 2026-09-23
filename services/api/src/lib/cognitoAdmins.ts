import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export interface CognitoAdminUser {
  username: string;
  email: string;
  status: string;
  enabled: boolean;
}

export interface SeedCognitoAdminUser extends CognitoAdminUser {
  groups: string[];
}

export interface CognitoAdminsClient {
  listUsers(): Promise<CognitoAdminUser[]>;
  adminCreateUser(input: { email: string }): Promise<CognitoAdminUser>;
  adminAddUserToGroup(username: string, group: string): Promise<void>;
  adminRemoveUserFromGroup(username: string, group: string): Promise<void>;
  adminListGroupsForUser(username: string): Promise<string[]>;
  adminDisableUser(username: string): Promise<void>;
  adminEnableUser(username: string): Promise<void>;
  adminGetUser(username: string): Promise<CognitoAdminUser>;
}

export class AwsCognitoAdmins implements CognitoAdminsClient {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  async listUsers(): Promise<CognitoAdminUser[]> {
    const users: CognitoAdminUser[] = [];
    let paginationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListUsersCommand({
          UserPoolId: this.userPoolId,
          PaginationToken: paginationToken,
        }),
      );
      for (const user of response.Users ?? []) {
        users.push(mapSdkUser(user));
      }
      paginationToken = response.PaginationToken;
    } while (paginationToken !== undefined);
    return users;
  }

  async adminCreateUser(input: { email: string }): Promise<CognitoAdminUser> {
    const response = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: input.email,
        UserAttributes: [
          { Name: "email", Value: input.email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    if (response.User === undefined) {
      throw new Error("Cognito created a user without returning it");
    }
    return mapSdkUser(response.User);
  }

  async adminAddUserToGroup(username: string, group: string): Promise<void> {
    await this.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: group,
      }),
    );
  }

  async adminRemoveUserFromGroup(username: string, group: string): Promise<void> {
    await this.client.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: group,
      }),
    );
  }

  async adminListGroupsForUser(username: string): Promise<string[]> {
    const groups: string[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: this.userPoolId,
          Username: username,
          NextToken: nextToken,
        }),
      );
      for (const group of response.Groups ?? []) {
        if (group.GroupName !== undefined) {
          groups.push(group.GroupName);
        }
      }
      nextToken = response.NextToken;
    } while (nextToken !== undefined);
    return groups;
  }

  async adminDisableUser(username: string): Promise<void> {
    await this.client.send(
      new AdminDisableUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
  }

  async adminEnableUser(username: string): Promise<void> {
    await this.client.send(
      new AdminEnableUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
  }

  async adminGetUser(username: string): Promise<CognitoAdminUser> {
    const user = await this.client.send(
      new AdminGetUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
    return {
      username: user.Username ?? username,
      email: attributeValue(user.UserAttributes, "email"),
      status: user.UserStatus ?? "UNKNOWN",
      enabled: user.Enabled ?? false,
    };
  }
}

export class InMemoryCognitoAdmins implements CognitoAdminsClient {
  private readonly users = new Map<string, SeedCognitoAdminUser>();

  constructor(seedUsers: readonly SeedCognitoAdminUser[] = []) {
    for (const user of seedUsers) {
      this.users.set(user.username, copySeedUser(user));
    }
  }

  async listUsers(): Promise<CognitoAdminUser[]> {
    return [...this.users.values()].map(withoutGroups);
  }

  async adminCreateUser(input: { email: string }): Promise<CognitoAdminUser> {
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      const error = new Error(`User ${input.email} already exists`);
      error.name = "UsernameExistsException";
      throw error;
    }
    const user: SeedCognitoAdminUser = {
      username: input.email,
      email: input.email,
      groups: [],
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
    };
    this.users.set(user.username, user);
    return withoutGroups(user);
  }

  async adminAddUserToGroup(username: string, group: string): Promise<void> {
    const user = this.requireUser(username);
    if (!user.groups.includes(group)) {
      user.groups.push(group);
    }
  }

  async adminRemoveUserFromGroup(username: string, group: string): Promise<void> {
    const user = this.requireUser(username);
    user.groups = user.groups.filter((candidate) => candidate !== group);
  }

  async adminListGroupsForUser(username: string): Promise<string[]> {
    return [...this.requireUser(username).groups];
  }

  async adminDisableUser(username: string): Promise<void> {
    this.requireUser(username).enabled = false;
  }

  async adminEnableUser(username: string): Promise<void> {
    this.requireUser(username).enabled = true;
  }

  async adminGetUser(username: string): Promise<CognitoAdminUser> {
    return withoutGroups(this.requireUser(username));
  }

  private requireUser(username: string): SeedCognitoAdminUser {
    const user = this.users.get(username);
    if (user === undefined) {
      const error = new Error(`User ${username} not found`);
      error.name = "UserNotFoundException";
      throw error;
    }
    return user;
  }
}

type SdkUser = {
  Username?: string;
  Attributes?: { Name?: string; Value?: string }[];
  UserStatus?: string;
  Enabled?: boolean;
};

function mapSdkUser(user: SdkUser): CognitoAdminUser {
  if (user.Username === undefined) {
    throw new Error("Cognito returned a user without a username");
  }
  return {
    username: user.Username,
    email: attributeValue(user.Attributes, "email"),
    status: user.UserStatus ?? "UNKNOWN",
    enabled: user.Enabled ?? false,
  };
}

function attributeValue(
  attributes: readonly { Name?: string; Value?: string }[] | undefined,
  name: string,
): string {
  return attributes?.find((attribute) => attribute.Name === name)?.Value ?? "";
}

function copySeedUser(user: SeedCognitoAdminUser): SeedCognitoAdminUser {
  return { ...user, groups: [...user.groups] };
}

function withoutGroups(user: SeedCognitoAdminUser): CognitoAdminUser {
  const { groups: _groups, ...cognitoUser } = user;
  return { ...cognitoUser };
}
