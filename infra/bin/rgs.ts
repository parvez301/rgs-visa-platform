import * as cdk from "aws-cdk-lib";
import { RgsPlatformStack } from "../lib/rgs-platform-stack";

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") ?? "staging";

new RgsPlatformStack(app, `RgsPlatform-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-south-1",
  },
});
