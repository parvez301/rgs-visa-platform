import {
  NoticeInputSchema,
  NoticeSchema,
  type Notice,
} from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import type { TableItem } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";

export const NOTICE_PARTITION_KEY = "NOTICE";

export function noticeSortKey(createdAt: string, noticeId: string): string {
  return `${createdAt}#${noticeId}`;
}

function itemToNotice(item: TableItem): Notice {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1PartitionKey,
    GSI1SK: _gsi1SortKey,
    GSI2PK: _gsi2PartitionKey,
    GSI2SK: _gsi2SortKey,
    GSI3PK: _gsi3PartitionKey,
    GSI3SK: _gsi3SortKey,
    ...noticeAttributes
  } = item;
  return NoticeSchema.parse(noticeAttributes);
}

export type PublicNotice = Omit<Notice, "createdByEmail" | "status" | "updatedAt">;

function toPublicNotice(notice: Notice): PublicNotice {
  return {
    noticeId: notice.noticeId,
    title: notice.title,
    body: notice.body,
    category: notice.category,
    severity: notice.severity,
    ...(notice.countryCode !== undefined ? { countryCode: notice.countryCode } : {}),
    pinned: notice.pinned,
    ...(notice.publishedAt !== undefined ? { publishedAt: notice.publishedAt } : {}),
    createdAt: notice.createdAt,
    ...(notice.expiresAt !== undefined ? { expiresAt: notice.expiresAt } : {}),
  };
}

async function findNoticeItem(
  context: AppContext,
  noticeId: string,
): Promise<TableItem | undefined> {
  const noticeItems = await context.table.query(NOTICE_PARTITION_KEY);
  return noticeItems.find((noticeItem) => noticeItem["noticeId"] === noticeId);
}

export async function listNotices(context: AppContext): Promise<Notice[]> {
  const noticeItems = await context.table.query(NOTICE_PARTITION_KEY);
  return noticeItems
    .map(itemToNotice)
    .sort((leftNotice, rightNotice) =>
      rightNotice.createdAt.localeCompare(leftNotice.createdAt),
    );
}

export async function listPublicNotices(
  context: AppContext,
  options: { countryCode?: string } = {},
): Promise<PublicNotice[]> {
  const todayIsoDate = context.now().toISOString().slice(0, 10);
  const publishedNotices = (await listNotices(context)).filter((notice) => {
    if (notice.status !== "PUBLISHED") return false;
    if (notice.expiresAt !== undefined && notice.expiresAt < todayIsoDate) return false;
    if (options.countryCode === undefined) return true;
    return (
      notice.countryCode === undefined || notice.countryCode === options.countryCode
    );
  });

  publishedNotices.sort((leftNotice, rightNotice) => {
    if (leftNotice.pinned !== rightNotice.pinned) {
      return leftNotice.pinned ? -1 : 1;
    }
    const leftPublishedAt = leftNotice.publishedAt ?? leftNotice.createdAt;
    const rightPublishedAt = rightNotice.publishedAt ?? rightNotice.createdAt;
    return rightPublishedAt.localeCompare(leftPublishedAt);
  });

  return publishedNotices.map(toPublicNotice);
}

export async function upsertNotice(
  context: AppContext,
  adminEmail: string,
  input: unknown,
): Promise<Notice> {
  const parseResult = NoticeInputSchema.safeParse(input);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw badRequest(
      firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid notice",
    );
  }
  const noticeInput = parseResult.data;
  const nowIso = context.now().toISOString();

  let existingNotice: Notice | null = null;
  if (noticeInput.noticeId) {
    const existingItem = await findNoticeItem(context, noticeInput.noticeId);
    if (existingItem) existingNotice = itemToNotice(existingItem);
  }

  const noticeId = noticeInput.noticeId ?? existingNotice?.noticeId ?? newId("ntc", context.now().getTime());
  const createdAt = existingNotice?.createdAt ?? nowIso;
  let publishedAt = existingNotice?.publishedAt;
  if (noticeInput.status === "PUBLISHED" && publishedAt === undefined) {
    publishedAt = nowIso;
  }

  const notice: Notice = {
    noticeId,
    title: noticeInput.title,
    body: noticeInput.body,
    category: noticeInput.category,
    severity: noticeInput.severity,
    ...(noticeInput.countryCode !== undefined
      ? { countryCode: noticeInput.countryCode }
      : {}),
    pinned: noticeInput.pinned ?? false,
    status: noticeInput.status ?? "DRAFT",
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(noticeInput.expiresAt !== undefined ? { expiresAt: noticeInput.expiresAt } : {}),
    createdAt,
    updatedAt: nowIso,
    createdByEmail: existingNotice?.createdByEmail ?? adminEmail,
  };

  await context.table.put({
    PK: NOTICE_PARTITION_KEY,
    SK: noticeSortKey(createdAt, noticeId),
    ...notice,
  });

  if (notice.status === "PUBLISHED") {
    await logActivity(
      context,
      "NOTICE_PUBLISHED",
      adminEmail,
      undefined,
      {
        noticeId: notice.noticeId,
        title: notice.title,
        ...(notice.countryCode !== undefined ? { countryCode: notice.countryCode } : {}),
      },
      { actorEmail: adminEmail, actorRole: "admin" },
    );
  }

  return notice;
}

export async function deleteNotice(context: AppContext, noticeId: string): Promise<void> {
  const existingItem = await findNoticeItem(context, noticeId);
  if (!existingItem) throw notFound("Notice");
  await context.table.delete(existingItem.PK, existingItem.SK);
}
