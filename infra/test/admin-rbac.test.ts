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

  it("seeds the initial admin into Owner through a deploy-time custom resource", () => {
    const customResources = resourcesOfType(
      synthesizedResources(),
      "Custom::AWS",
    );
    const serialized = JSON.stringify(customResources);

    assert.match(serialized, /adminAddUserToGroup/i);
    assert.match(serialized, /admin@raysglobalservices\.com/);
    assert.match(serialized, /Owner/);
  });
});
