import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

export interface OutboundEmail {
  toAddress: string;
  subject: string;
  bodyText: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<void>;
}

export interface SesEmailSenderOptions {
  fromAddress: string;
  /** Defaults to the Lambda's region when unset. */
  region?: string;
  /**
   * Cross-account role that may `ses:SendEmail` in a production-access SES
   * account. When set, each send assumes the role (with ExternalId) before
   * calling SES. Hireloop's own ap-south-1 SES is still sandboxed.
   */
  roleArn?: string;
  externalId?: string;
}

/**
 * Builds an SES client. With `roleArn`, assumes that role first so sends go
 * through the production-access account (us-east-1) rather than the sandbox
 * account the Lambda runs in.
 */
async function resolveSesClient(options: SesEmailSenderOptions): Promise<SESClient> {
  const region = options.region ?? process.env["AWS_REGION"] ?? "ap-south-1";
  if (options.roleArn === undefined || options.roleArn.trim() === "") {
    return new SESClient({ region });
  }

  const sts = new STSClient({ region: process.env["AWS_REGION"] ?? "ap-south-1" });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: options.roleArn,
      RoleSessionName: "rgs-crm-ses-send",
      ...(options.externalId !== undefined && options.externalId.trim() !== ""
        ? { ExternalId: options.externalId }
        : {}),
      DurationSeconds: 900,
    }),
  );
  const credentials = assumed.Credentials;
  if (
    credentials?.AccessKeyId === undefined ||
    credentials.SecretAccessKey === undefined ||
    credentials.SessionToken === undefined
  ) {
    throw new Error("STS AssumeRole returned no credentials for SES send");
  }

  return new SESClient({
    region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });
}

export class SesEmailSender implements EmailSender {
  constructor(
    private readonly fromAddress: string,
    private readonly sesClient?: SESClient,
    private readonly assumeOptions?: Omit<SesEmailSenderOptions, "fromAddress">,
  ) {}

  /** Preferred constructor when cross-account SES is configured. */
  static fromOptions(options: SesEmailSenderOptions): SesEmailSender {
    return new SesEmailSender(options.fromAddress, undefined, {
      region: options.region,
      roleArn: options.roleArn,
      externalId: options.externalId,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    const client =
      this.sesClient ??
      (await resolveSesClient({
        fromAddress: this.fromAddress,
        ...this.assumeOptions,
      }));
    await client.send(
      new SendEmailCommand({
        Source: this.fromAddress,
        Destination: { ToAddresses: [email.toAddress] },
        Message: {
          Subject: { Data: email.subject },
          Body: { Text: { Data: email.bodyText } },
        },
      }),
    );
  }
}

/** Test adapter — records instead of sending. */
export class InMemoryEmailSender implements EmailSender {
  readonly sentEmails: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.sentEmails.push(email);
  }
}

/**
 * Email is a notification, never a transaction: a failed send (SES sandbox,
 * unverified identity) must not fail the user's submit/transition.
 */
export class BestEffortEmailSender implements EmailSender {
  constructor(private readonly innerSender: EmailSender) {}

  async send(email: OutboundEmail): Promise<void> {
    try {
      await this.innerSender.send(email);
    } catch (error) {
      console.error(`Email send failed (to=${email.toAddress}, subject=${email.subject})`, error);
    }
  }
}
