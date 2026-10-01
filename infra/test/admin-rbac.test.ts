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

function resourcesOfType(
  resources: Record<string, Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> {
  return Object.values(resources).filter((resource) => resource.Type === type);
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

  it("gives CRM database config to the admin API and appointment reminders Lambdas, never the user API", () => {
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
      for (const key of ["DATABASE_URL", "LEDGER_STORE", "CRM_STORE"]) {
        assert.equal(environments["rgs-user-api-test"]?.[key], undefined, key);
      }
    } finally {
      if (previousUrl === undefined) delete process.env["RGS_DATABASE_URL"];
      else process.env["RGS_DATABASE_URL"] = previousUrl;
      if (previousStore === undefined) delete process.env["RGS_LEDGER_STORE"];
      else process.env["RGS_LEDGER_STORE"] = previousStore;
      if (previousCrmStore === undefined) delete process.env["RGS_CRM_STORE"];
      else process.env["RGS_CRM_STORE"] = previousCrmStore;
    }
  });

  it("leaves appointment reminders on Dynamo when no CRM Postgres config is set", () => {
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
      assert.equal(variables["CRM_STORE"], undefined);
    } finally {
      if (saved.url !== undefined) process.env["RGS_DATABASE_URL"] = saved.url;
      if (saved.crm !== undefined) process.env["RGS_CRM_STORE"] = saved.crm;
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
});
