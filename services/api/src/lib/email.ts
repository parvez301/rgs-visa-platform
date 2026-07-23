import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export interface OutboundEmail {
  toAddress: string;
  subject: string;
  bodyText: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<void>;
}

export class SesEmailSender implements EmailSender {
  constructor(
    private readonly fromAddress: string,
    private readonly sesClient: SESClient = new SESClient({}),
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    await this.sesClient.send(
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
