import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RgsSesEventsStack, SES_CONFIGURATION_SET_NAME } from "../lib/rgs-ses-events-stack";

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new RgsSesEventsStack(app, "SesEventsTest", {
    env: { account: "781517218736", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("SES events stack (mail delivery observability)", () => {
  it("creates the configuration set the Lambdas stamp on every send", () => {
    synthesize().hasResourceProperties("AWS::SES::ConfigurationSet", {
      Name: SES_CONFIGURATION_SET_NAME,
    });
  });

  it("routes bounces, complaints and rejects to the alerts topic", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::SNS::Topic", 1);
    const destinations = Object.values(
      template.findResources("AWS::SES::ConfigurationSetEventDestination"),
    );
    const snsDestination = destinations.find(
      (destination) =>
        (destination["Properties"] as { EventDestination: { SnsDestination?: unknown } }).EventDestination
          .SnsDestination !== undefined,
    );
    assert.ok(snsDestination, "no SNS event destination");
    const eventTypes = (
      snsDestination["Properties"] as { EventDestination: { MatchingEventTypes: string[] } }
    ).EventDestination.MatchingEventTypes;
    for (const required of ["bounce", "complaint", "reject"]) {
      assert.ok(eventTypes.includes(required), `${required} not routed to SNS`);
    }
  });

  it("publishes every event type to CloudWatch, keyed by the configuration set", () => {
    const template = synthesize();
    const destinations = Object.values(
      template.findResources("AWS::SES::ConfigurationSetEventDestination"),
    );
    const cloudWatchDestination = destinations.find(
      (destination) =>
        (destination["Properties"] as { EventDestination: { CloudWatchDestination?: unknown } })
          .EventDestination.CloudWatchDestination !== undefined,
    );
    assert.ok(cloudWatchDestination, "no CloudWatch event destination");
    const eventTypes = (
      cloudWatchDestination["Properties"] as { EventDestination: { MatchingEventTypes: string[] } }
    ).EventDestination.MatchingEventTypes;
    for (const required of ["send", "delivery", "bounce", "complaint", "reject"]) {
      assert.ok(eventTypes.includes(required), `${required} not sent to CloudWatch`);
    }
  });

  it("alarms on the first bounce and the first reject, into the same topic", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Bounce",
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Reject",
      Threshold: 1,
    });
  });
});
