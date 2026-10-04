import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RgsPlatformStack } from "../lib/rgs-platform-stack";

function synthesizedResources(): Record<string, Record<string, unknown>> {
  const app = new cdk.App();
  const stack = new RgsPlatformStack(app, "AdminRbacTest", {
    stage: "test",
    env: { account: "111111111111", region: "ap-south-1" },
  });
  return Template.fromStack(stack).toJSON().Resources;
}

function synthesizedResourcesForStage(
  stage: string,
): Record<string, Record<string, unknown>> {
  const app = new cdk.App();
  const stack = new RgsPlatformStack(app, `AdminRbacTest-${stage}`, {
    stage,
    env: { account: "111111111111", region: "ap-south-1" },
  });
  return Template.fromStack(stack).toJSON().Resources;
}

function resourcesOfType(
  resources: Record<string, Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> {
  return Object.values(resources).filter((resource) => resource.Type === type);
}

function dynamoTables(
  resources: Record<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return resourcesOfType(resources, "AWS::DynamoDB::Table");
}

/** D.3 removed the platform-table env var; synth must not resurrect it. */
const LEGACY_PLATFORM_TABLE_ENV = "TABLE" + "_NAME";

function assertLambdasLackLegacyPlatformTableEnv(
  env: Record<string, Record<string, unknown>>,
  lambdaNames: string[],
): void {
  for (const name of lambdaNames) {
    assert.equal(env[name]?.[LEGACY_PLATFORM_TABLE_ENV], undefined);
  }
}

function lambdaEnvByName(
  resources: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    resourcesOfType(resources, "AWS::Lambda::Function")
      .filter((fn) => typeof (fn.Properties as { FunctionName?: unknown }).FunctionName === "string")
      .map((fn) => {
        const props = fn.Properties as {
          FunctionName: string;
          Environment?: { Variables?: Record<string, unknown> };
        };
        return [props.FunctionName, props.Environment?.Variables ?? {}];
      }),
  );
}

describe("admin RBAC infrastructure", () => {
  it("creates the exact four admin user-pool groups", () => {
    const groups = resourcesOfType(synthesizedResources(), "AWS::Cognito::UserPoolGroup");
    assert.deepEqual(
      groups.map((group) => (group.Properties as { GroupName: string }).GroupName).sort(),
      ["Finance", "Ops", "Owner", "Viewer"],
    );
  });

  it("passes the admins pool ID to admin and appointment Lambdas only", () => {
    const functions = resourcesOfType(synthesizedResources(), "AWS::Lambda::Function");
    const environments = Object.fromEntries(
      functions
        .filter((fn) => typeof (fn.Properties as { FunctionName?: unknown }).FunctionName === "string")
        .map((fn) => {
          const props = fn.Properties as {
            FunctionName: string;
            Environment?: { Variables?: Record<string, unknown> };
          };
          return [props.FunctionName, props.Environment?.Variables ?? {}];
        }),
    );

    assert.ok(environments["rgs-admin-api-test"]?.["ADMINS_USER_POOL_ID"]);
    assert.ok(environments["rgs-appointment-reminders-test"]?.["ADMINS_USER_POOL_ID"]);
    assert.equal(environments["rgs-user-api-test"]?.["ADMINS_USER_POOL_ID"], undefined);
  });

  it("gives CRM database config to admin, user API, and reminders Lambdas; LEDGER_STORE stays admin-only", () => {
    const previousUrl = process.env["RGS_DATABASE_URL"];
    const previousStore = process.env["RGS_LEDGER_STORE"];
    const previousCrmStore = process.env["RGS_CRM_STORE"];
    process.env["RGS_DATABASE_URL"] = "postgresql://example.invalid:6543/postgres";
    process.env["RGS_LEDGER_STORE"] = "postgres";
    process.env["RGS_CRM_STORE"] = "postgres";
    try {
      const functions = resourcesOfType(synthesizedResources(), "AWS::Lambda::Function");
      const environments = Object.fromEntries(
        functions
          .filter((fn) => typeof (fn.Properties as { FunctionName?: unknown }).FunctionName === "string")
          .map((fn) => {
            const props = fn.Properties as {
              FunctionName: string;
              Environment?: { Variables?: Record<string, unknown> };
            };
            return [props.FunctionName, props.Environment?.Variables ?? {}];
          }),
      );

      assert.equal(
        environments["rgs-admin-api-test"]?.["DATABASE_URL"],
        "postgresql://example.invalid:6543/postgres",
      );
      assert.equal(environments["rgs-admin-api-test"]?.["LEDGER_STORE"], "postgres");
      assert.equal(environments["rgs-admin-api-test"]?.["CRM_STORE"], "postgres");
      // Reminders read and stamp cases through the CRM store seam, so after
      // cutover they must see Postgres, not the frozen Dynamo copy.
      assert.equal(
        environments["rgs-appointment-reminders-test"]?.["DATABASE_URL"],
        "postgresql://example.invalid:6543/postgres",
      );
      assert.equal(environments["rgs-appointment-reminders-test"]?.["CRM_STORE"], "postgres");
      assert.equal(environments["rgs-appointment-reminders-test"]?.["LEDGER_STORE"], undefined);
      // C.2.1: portal writes (applications/profiles/documents/activity) go
      // through CRM_STORE on the user API, so it needs the same CRM Postgres env.
      assert.equal(
        environments["rgs-user-api-test"]?.["DATABASE_URL"],
        "postgresql://example.invalid:6543/postgres",
      );
      assert.equal(environments["rgs-user-api-test"]?.["CRM_STORE"], "postgres");
      // Ledger stays admin-only.
      assert.equal(environments["rgs-user-api-test"]?.["LEDGER_STORE"], undefined);
    } finally {
      if (previousUrl === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = previousUrl;
      if (previousStore === undefined) delete process.env["RGS_LEDGER_STORE"];
      else process.env["RGS_LEDGER_STORE"] = previousStore;
      if (previousCrmStore === undefined) delete process.env["RGS_CRM_STORE"];
      else process.env["RGS_CRM_STORE"] = previousCrmStore;
    }
  });

  it("sets appointment reminders CRM_STORE to postgres when no CRM Postgres URL is set", () => {
    const saved = {
      url: process.env["RGS_DATABASE_URL"],
      crm: process.env["RGS_CRM_STORE"],
    };
    delete process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_CRM_STORE"];
    try {
      const reminders = resourcesOfType(synthesizedResources(), "AWS::Lambda::Function").find(
        (fn) => (fn.Properties as { FunctionName?: unknown }).FunctionName === "rgs-appointment-reminders-test",
      );
      const variables =
        (reminders?.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {};
      assert.equal(variables["DATABASE_URL"], undefined);
      assert.equal(variables["CRM_STORE"], "postgres");
    } finally {
      if (saved.url !== undefined) process.env["RGS_DATABASE_URL"] = saved.url;
      if (saved.crm !== undefined) process.env["RGS_CRM_STORE"] = saved.crm;
    }
  });

  it("defaults CRM_STORE and LEDGER_STORE to postgres on staging when RGS_* unset", () => {
    const saved = {
      url: process.env["RGS_DATABASE_URL"],
      crm: process.env["RGS_CRM_STORE"],
      ledger: process.env["RGS_LEDGER_STORE"],
    };
    delete process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_CRM_STORE"];
    delete process.env["RGS_LEDGER_STORE"];
    try {
      const env = lambdaEnvByName(synthesizedResourcesForStage("staging"));
      assert.equal(env["rgs-admin-api-staging"]?.["CRM_STORE"], "postgres");
      assert.equal(env["rgs-admin-api-staging"]?.["LEDGER_STORE"], "postgres");
      assert.equal(env["rgs-user-api-staging"]?.["CRM_STORE"], "postgres");
      assert.equal(env["rgs-user-api-staging"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-appointment-reminders-staging"]?.["CRM_STORE"], "postgres");
    } finally {
      if (saved.url === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = saved.url;
      if (saved.crm === undefined) delete process.env["RGS_CRM_STORE"];
      else process.env["RGS_CRM_STORE"] = saved.crm;
      if (saved.ledger === undefined) delete process.env["RGS_LEDGER_STORE"];
      else process.env["RGS_LEDGER_STORE"] = saved.ledger;
    }
  });

  it("defaults CRM_STORE and LEDGER_STORE to postgres on prod when RGS_* unset", () => {
    const saved = {
      url: process.env["RGS_DATABASE_URL"],
      crm: process.env["RGS_CRM_STORE"],
      ledger: process.env["RGS_LEDGER_STORE"],
    };
    delete process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_CRM_STORE"];
    delete process.env["RGS_LEDGER_STORE"];
    try {
      const env = lambdaEnvByName(synthesizedResourcesForStage("prod"));
      assert.equal(env["rgs-admin-api-prod"]?.["CRM_STORE"], "postgres");
      assert.equal(env["rgs-admin-api-prod"]?.["LEDGER_STORE"], "postgres");
      assert.equal(env["rgs-user-api-prod"]?.["CRM_STORE"], "postgres");
      assert.equal(env["rgs-user-api-prod"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-appointment-reminders-prod"]?.["CRM_STORE"], "postgres");
    } finally {
      if (saved.url === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = saved.url;
      if (saved.crm === undefined) delete process.env["RGS_CRM_STORE"];
      else process.env["RGS_CRM_STORE"] = saved.crm;
      if (saved.ledger === undefined) delete process.env["RGS_LEDGER_STORE"];
      else process.env["RGS_LEDGER_STORE"] = saved.ledger;
    }
  });

  it("grants Cognito staff administration actions to the admin API role only", () => {
    const resources = synthesizedResources();
    const functions = resourcesOfType(resources, "AWS::Lambda::Function");
    const roleByFunctionName = Object.fromEntries(
      functions
        .filter((fn) => typeof (fn.Properties as { FunctionName?: unknown }).FunctionName === "string")
        .map((fn) => {
          const props = fn.Properties as { FunctionName: string; Role: { "Fn::GetAtt": [string] } };
          return [props.FunctionName, props.Role["Fn::GetAtt"][0]];
        }),
    );
    const policies = resourcesOfType(resources, "AWS::IAM::Policy");
    const requiredActions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
    ].sort();

    const rolesWithRequiredActions = policies.flatMap((policy) => {
      const props = policy.Properties as {
        Roles: Array<{ Ref: string }>;
        PolicyDocument: { Statement: Array<{ Action: string | string[] }> };
      };
      const actions = props.PolicyDocument.Statement.flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );
      return requiredActions.every((action) => actions.includes(action))
        ? props.Roles.map((role) => role.Ref)
        : [];
    });

    assert.deepEqual(rolesWithRequiredActions, [roleByFunctionName["rgs-admin-api-test"]]);
  });

  it("does not block deploy on a Cognito Owner seed custom resource", () => {
    const customAws = resourcesOfType(synthesizedResources(), "Custom::AWS");
    const serialized = JSON.stringify(customAws);
    assert.equal(serialized.includes("adminAddUserToGroup"), false);
  });

  it("does not own a platform Dynamo table on staging", () => {
    const resources = synthesizedResourcesForStage("staging");
    assert.equal(dynamoTables(resources).length, 0);
    const env = lambdaEnvByName(resources);
    assertLambdasLackLegacyPlatformTableEnv(env, [
      "rgs-admin-api-staging",
      "rgs-user-api-staging",
      "rgs-appointment-reminders-staging",
    ]);
  });

  it("does not own a platform Dynamo table on prod", () => {
    const resources = synthesizedResourcesForStage("prod");
    assert.equal(dynamoTables(resources).length, 0);
    const env = lambdaEnvByName(resources);
    assertLambdasLackLegacyPlatformTableEnv(env, [
      "rgs-admin-api-prod",
      "rgs-user-api-prod",
      "rgs-appointment-reminders-prod",
    ]);
  });

  it("does not own a platform Dynamo table on test", () => {
    const resources = synthesizedResources();
    assert.equal(dynamoTables(resources).length, 0);
    const env = lambdaEnvByName(resources);
    assertLambdasLackLegacyPlatformTableEnv(env, [
      "rgs-admin-api-test",
      "rgs-user-api-test",
      "rgs-appointment-reminders-test",
    ]);
  });
});
