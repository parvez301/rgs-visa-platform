import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { AppContext } from "../lib/context";
import { DynamoTableClient } from "../lib/db";
import { S3DocumentStore } from "../lib/documentStore";
import { BestEffortEmailSender, SesEmailSender } from "../lib/email";
import { buildAdminRouter } from "./adminApi";
import { buildUserRouter } from "./userApi";

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
  return {
    table: new DynamoTableClient(tableName),
    documents: new S3DocumentStore(documentsBucket),
    email: new BestEffortEmailSender(new SesEmailSender(senderAddress)),
    adminNotificationAddress,
    now: () => new Date(),
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
