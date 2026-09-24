import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

/**
 * The name the API Lambdas stamp on every SendEmail (SES_CONFIGURATION_SET in
 * rgs-platform-stack.ts). One shared value, exported, so the two stacks
 * cannot drift apart: a Lambda naming a set that does not exist gets every
 * send rejected by SES.
 */
export const SES_CONFIGURATION_SET_NAME = "rgs-crm";

/**
 * Mail-delivery observability for the CRM (feedback round 1, 2026-09-24:
 * "how do we ensure mail delivery happens successfully").
 *
 * Lives in the CLOUD account (781517218736, us-east-1), not the platform
 * account, because that is where the verified sending identity is and a
 * configuration set must sit next to the identity that uses it. The platform
 * Lambdas reach it through RgsCrmSesSendRole, which already allows
 * ses:SendEmail on every resource, configuration sets included.
 *
 * Deploy with the `cloud` AWS profile:
 *   AWS_PROFILE=cloud pnpm --filter @rgs/infra exec cdk deploy RgsSesEvents
 *
 * What it gives:
 *   - Every SES event (send, delivery, bounce, complaint, reject, delay,
 *     rendering failure) lands in CloudWatch under AWS/SES, dimensioned by
 *     this configuration set, so "did any mail bounce this week" is a graph.
 *   - Bounce, complaint, reject, delay and rendering failure are also
 *     published to an SNS topic with the full SES event payload (recipient,
 *     bounce type, diagnostic code).
 *   - Two alarms, first bounce and first reject, notify the same topic.
 *
 * The topic has NO subscribers on purpose. Subscribing an address sends that
 * address a confirmation mail, which is the owner's call, not this stack's.
 */
export class RgsSesEventsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const mailAlertsTopic = new sns.Topic(this, "MailAlertsTopic", {
      topicName: "rgs-crm-mail-alerts",
      displayName: "RGS CRM mail delivery alerts",
    });

    const configurationSet = new ses.ConfigurationSet(this, "CrmConfigurationSet", {
      configurationSetName: SES_CONFIGURATION_SET_NAME,
      reputationMetrics: true,
      sendingEnabled: true,
    });

    configurationSet.addEventDestination("AllEventsToCloudWatch", {
      configurationSetEventDestinationName: "rgs-crm-cloudwatch",
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ],
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          name: "ses:configuration-set",
          defaultValue: SES_CONFIGURATION_SET_NAME,
        },
      ]),
    });

    configurationSet.addEventDestination("FailuresToSns", {
      configurationSetEventDestinationName: "rgs-crm-failures-sns",
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ],
      destination: ses.EventDestination.snsTopic(mailAlertsTopic),
    });

    const alarmDimensions = { "ses:configuration-set": SES_CONFIGURATION_SET_NAME };
    const alarmOnFirst = (metricName: "Bounce" | "Reject", constructId: string) => {
      const alarm = new cloudwatch.Alarm(this, constructId, {
        alarmName: `rgs-crm-mail-${metricName.toLowerCase()}`,
        alarmDescription: `At least one CRM email ${metricName.toLowerCase()}d in the last 5 minutes`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/SES",
          metricName,
          dimensionsMap: alarmDimensions,
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(mailAlertsTopic));
    };
    alarmOnFirst("Bounce", "BounceAlarm");
    alarmOnFirst("Reject", "RejectAlarm");

    new cdk.CfnOutput(this, "ConfigurationSetName", { value: configurationSet.configurationSetName });
    new cdk.CfnOutput(this, "MailAlertsTopicArn", { value: mailAlertsTopic.topicArn });
  }
}
