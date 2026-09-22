import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { AppContext } from "../lib/context";
import { DynamoTableClient } from "../lib/db";
import { withWriteRetries, writeRetryOptionsFromEnvironment } from "../lib/tableRetry";
import { S3DocumentStore } from "../lib/documentStore";
import { BestEffortEmailSender, SesEmailSender } from "../lib/email";
import { llmProviderConfigFromEnvironment } from "../agent/providers/config";
import { createLlmProvider } from "../agent/providers/index";
import type { LlmProvider } from "../agent/providers/types";
import { runAppointmentReminders } from "../domain/crm/appointmentReminders";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { buildAdminRouter } from "./adminApi";
import { buildUserRouter } from "./userApi";

/**
 * llmProviderConfigFromEnvironment throws when LLM_PROVIDER, LLM_MODEL or
 * LLM_API_KEY is missing (providers/config.ts) -- deliberately, so a
 * deployment never silently runs the agent on an unconfigured model. This
 * function is shared with every non-agent route AND with the migration CLI
 * (buildProductionContext's own doc comment), neither of which has ever set
 * those variables, so a bare, un-caught call here would take the whole API
 * down at cold start over a feature those routes never touch
 * (task-11-controller-notes.md §3). Attempted once and swallowed on
 * failure, leaving `llm` undefined -- exactly what AppContext already
 * declares for "no agent configured" -- rather than built eagerly.
 */
function tryBuildLlmProvider(): LlmProvider | undefined {
  try {
    return createLlmProvider(llmProviderConfigFromEnvironment(process.env));
  } catch (configurationError) {
    // The laziness above is right (P27); the SILENCE was not (branch review
    // M1). A typo'd LLM_PROVIDER or an unsupported LLM_THINKING value is
    // indistinguishable, from outside, from "the agent is not enabled here":
    // both present to the owner as every agent turn answering "This request
    // has no LLM provider configured", with nothing anywhere saying why.
    // `llmProviderConfigFromEnvironment` throws a message naming the missing
    // or invalid variable, so logging it is the whole fix.
    //
    // Safe to log: providers/config.ts never puts LLM_API_KEY's VALUE in a
    // thrown message, and providers.test.ts's two leak tests exist
    // specifically to keep that true. Do not widen this to log the config
    // object or process.env.
    const configurationErrorMessage =
      configurationError instanceof Error ? configurationError.message : String(configurationError);
    console.warn(
      `No LLM provider configured, so agent routes will refuse every turn: ${configurationErrorMessage}`,
    );
    return undefined;
  }
}

/**
 * Exported so `services/migration/src/cli.ts` can reuse the exact same
 * production wiring rather than assembling a second `AppContext` builder by
 * hand. The migration CLI points at the same real DynamoDB table this
 * Lambda does, so it must be configured (and fail closed) the same way.
 */
export function buildProductionContext(): AppContext {
  const tableName = process.env["TABLE_NAME"];
  const documentsBucket = process.env["DOCUMENTS_BUCKET"];
  const senderAddress = process.env["EMAIL_SENDER"];
  const adminNotificationAddress = process.env["ADMIN_NOTIFICATION_EMAIL"];
  if (!tableName || !documentsBucket || !senderAddress || !adminNotificationAddress) {
    throw new Error(
      "Missing required environment: TABLE_NAME, DOCUMENTS_BUCKET, EMAIL_SENDER, ADMIN_NOTIFICATION_EMAIL",
    );
  }
  const llmProvider = tryBuildLlmProvider();
  return {
    // N11: every write in the process goes through the retry seam, including
    // the migration's -- `cli.ts` builds its context from this same function,
    // which is why the wrapping belongs here and not at a call site. Reads are
    // not wrapped; see `tableRetry.ts` for why.
    table: withWriteRetries(
      new DynamoTableClient(tableName),
      writeRetryOptionsFromEnvironment(process.env),
    ),
    documents: new S3DocumentStore(documentsBucket),
    email: new BestEffortEmailSender(
      SesEmailSender.fromOptions({
        fromAddress: senderAddress,
        region: process.env["SES_REGION"],
        roleArn: process.env["SES_ROLE_ARN"],
        externalId: process.env["SES_EXTERNAL_ID"],
      }),
    ),
    adminNotificationAddress,
    now: () => new Date(),
    ...(llmProvider !== undefined ? { llm: llmProvider } : {}),
  };
}

let cachedUserRouter: ReturnType<typeof buildUserRouter> | undefined;
let cachedAdminRouter: ReturnType<typeof buildAdminRouter> | undefined;

export async function userApiHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  cachedUserRouter ??= buildUserRouter(buildProductionContext());
  return cachedUserRouter.dispatch(event);
}

export async function adminApiHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  cachedAdminRouter ??= buildAdminRouter(buildProductionContext());
  return cachedAdminRouter.dispatch(event);
}

/**
 * EventBridge daily target: email partners for appointments 24–48h out.
 * Shares production context with the API Lambdas (same table / SES).
 */
export async function appointmentRemindersHandler(): Promise<{
  scanned: number;
  reminded: number;
  skipped: number;
}> {
  const context = buildProductionContext();
  const todayIso = context.now().toISOString().slice(0, 10);
  return runAppointmentReminders(context, DEFAULT_TENANT_ID, todayIso);
}
