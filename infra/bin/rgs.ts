import * as cdk from "aws-cdk-lib";
import { RgsPlatformStack } from "../lib/rgs-platform-stack";
import { RgsSesEventsStack } from "../lib/rgs-ses-events-stack";

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

// Mail-delivery events live next to the verified SES identity in the cloud
// account. Deployed separately, with the `cloud` profile -- see the stack's
// own doc comment. `cdk deploy RgsPlatform-<stage>` never touches it.
new RgsSesEventsStack(app, "RgsSesEvents", {
  env: { account: "781517218736", region: "us-east-1" },
});
