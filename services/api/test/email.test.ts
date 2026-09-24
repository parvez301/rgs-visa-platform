import { describe, expect, it } from "vitest";
import type { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SesEmailSender } from "../src/lib/email";

/**
 * A stand-in SESClient that records the command it was handed. The SDK's
 * `send` is generic over the command type; the sender only ever hands it a
 * SendEmailCommand, so that is all this fake needs to understand.
 */
function buildRecordingSesClient(): { client: SESClient; sentCommands: SendEmailCommand[] } {
  const sentCommands: SendEmailCommand[] = [];
  const client = {
    send: async (command: SendEmailCommand) => {
      sentCommands.push(command);
      return { MessageId: "recorded" };
    },
  } as unknown as SESClient;
  return { client, sentCommands };
}

describe("SesEmailSender", () => {
  it("stamps every send with the configuration set when one is configured, so SES routes its events", async () => {
    const { client, sentCommands } = buildRecordingSesClient();
    const sender = new SesEmailSender("no-reply@hireloop.xyz", client, { configurationSetName: "rgs-crm" });

    await sender.send({ toAddress: "desk@example.test", subject: "s", bodyText: "b" });

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]!.input.ConfigurationSetName).toBe("rgs-crm");
  });

  it("sends without a configuration set when none is configured", async () => {
    const { client, sentCommands } = buildRecordingSesClient();
    const sender = new SesEmailSender("no-reply@hireloop.xyz", client);

    await sender.send({ toAddress: "desk@example.test", subject: "s", bodyText: "b" });

    expect(sentCommands[0]!.input.ConfigurationSetName).toBeUndefined();
  });
});
