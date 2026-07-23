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
