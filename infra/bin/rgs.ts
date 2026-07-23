import * as cdk from "aws-cdk-lib";
import { RgsPlatformStack } from "../lib/rgs-platform-stack";

const app = new cdk.App();
// Stage comes from RGS_STAGE env (shell hooks mangle -c context flags)
const stage = app.node.tryGetContext("stage") ?? process.env.RGS_STAGE ?? "staging";

new RgsPlatformStack(app, `RgsPlatform-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-south-1",
  },
});
