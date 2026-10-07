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

  it("gives DATABASE_URL to admin, user API, and reminders Lambdas and sets no store flags", () => {
    const previousUrl = process.env["RGS_DATABASE_URL"];
    process.env["RGS_DATABASE_URL"] = "postgresql://example.invalid:6543/postgres";
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
      assert.equal(environments["rgs-admin-api-test"]?.["CRM_STORE"], undefined);
      assert.equal(environments["rgs-admin-api-test"]?.["LEDGER_STORE"], undefined);
      assert.equal(
        environments["rgs-appointment-reminders-test"]?.["DATABASE_URL"],
        "postgresql://example.invalid:6543/postgres",
      );
      assert.equal(environments["rgs-appointment-reminders-test"]?.["CRM_STORE"], undefined);
      assert.equal(environments["rgs-appointment-reminders-test"]?.["LEDGER_STORE"], undefined);
      assert.equal(
        environments["rgs-user-api-test"]?.["DATABASE_URL"],
        "postgresql://example.invalid:6543/postgres",
      );
      assert.equal(environments["rgs-user-api-test"]?.["CRM_STORE"], undefined);
      assert.equal(environments["rgs-user-api-test"]?.["LEDGER_STORE"], undefined);
    } finally {
      if (previousUrl === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = previousUrl;
    }
  });

  it("omits DATABASE_URL on appointment reminders when no CRM Postgres URL is set", () => {
    const savedUrl = process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_DATABASE_URL"];
    try {
      const reminders = resourcesOfType(synthesizedResources(), "AWS::Lambda::Function").find(
        (fn) => (fn.Properties as { FunctionName?: unknown }).FunctionName === "rgs-appointment-reminders-test",
      );
      const variables =
        (reminders?.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {};
      assert.equal(variables["DATABASE_URL"], undefined);
      assert.equal(variables["CRM_STORE"], undefined);
      const environments = lambdaEnvByName(synthesizedResources());
      assert.equal(environments["rgs-admin-api-test"]?.["DATABASE_URL"], undefined);
      assert.equal(environments["rgs-user-api-test"]?.["DATABASE_URL"], undefined);
    } finally {
      if (savedUrl !== undefined) process.env["RGS_DATABASE_URL"] = savedUrl;
    }
  });

  it("sets no CRM_STORE or LEDGER_STORE on staging", () => {
    const savedUrl = process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_DATABASE_URL"];
    try {
      const env = lambdaEnvByName(synthesizedResourcesForStage("staging"));
      assert.equal(env["rgs-admin-api-staging"]?.["CRM_STORE"], undefined);
      assert.equal(env["rgs-admin-api-staging"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-user-api-staging"]?.["CRM_STORE"], undefined);
      assert.equal(env["rgs-user-api-staging"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-appointment-reminders-staging"]?.["CRM_STORE"], undefined);
    } finally {
      if (savedUrl === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = savedUrl;
    }
  });

  it("sets no CRM_STORE or LEDGER_STORE on prod", () => {
    const savedUrl = process.env["RGS_DATABASE_URL"];
    delete process.env["RGS_DATABASE_URL"];
    try {
      const env = lambdaEnvByName(synthesizedResourcesForStage("prod"));
      assert.equal(env["rgs-admin-api-prod"]?.["CRM_STORE"], undefined);
      assert.equal(env["rgs-admin-api-prod"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-user-api-prod"]?.["CRM_STORE"], undefined);
      assert.equal(env["rgs-user-api-prod"]?.["LEDGER_STORE"], undefined);
      assert.equal(env["rgs-appointment-reminders-prod"]?.["CRM_STORE"], undefined);
    } finally {
      if (savedUrl === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = savedUrl;
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
      "cognito-idp:AdminSetUserPassword",
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

  it("does not attach custom domains on prod unless RGS_SPA_CERTIFICATE_ARN is set", () => {
    const savedArn = process.env["RGS_SPA_CERTIFICATE_ARN"];
    const savedMarketingArn = process.env["RGS_MARKETING_CERTIFICATE_ARN"];
    delete process.env["RGS_SPA_CERTIFICATE_ARN"];
    delete process.env["RGS_MARKETING_CERTIFICATE_ARN"];
    try {
      const distributions = resourcesOfType(
        synthesizedResourcesForStage("prod"),
        "AWS::CloudFront::Distribution",
      );
      for (const distribution of distributions) {
        const aliases =
          (distribution.Properties as { DistributionConfig?: { Aliases?: unknown } })
            .DistributionConfig?.Aliases ?? [];
        assert.equal(Array.isArray(aliases) ? aliases.length : 0, 0);
      }
    } finally {
      if (savedArn === undefined) delete process.env["RGS_SPA_CERTIFICATE_ARN"];
      else process.env["RGS_SPA_CERTIFICATE_ARN"] = savedArn;
      if (savedMarketingArn === undefined) delete process.env["RGS_MARKETING_CERTIFICATE_ARN"];
      else process.env["RGS_MARKETING_CERTIFICATE_ARN"] = savedMarketingArn;
    }
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
