import { NoticeSchema, type Notice } from "@rgs/shared";
import { z } from "zod";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { CreateLeadSchema, type Lead } from "@rgs/api/src/domain/leads";
import { insertLeadPostgres } from "@rgs/api/src/domain/leadsPostgres";
import { NOTICE_PARTITION_KEY } from "@rgs/api/src/domain/notices";
import { upsertNoticePostgres } from "@rgs/api/src/domain/noticesPostgres";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { parseStoredRecord, storedRecordId, stripStorageKeys } from "@rgs/api/src/lib/storedRecords";
import { describeError, isRecordLevelDatabaseError } from "./backfillCrmRemainingToPostgres";

// Mirrors the private GSI partition written by createLead in @rgs/api domain/leads.ts.
const LEAD_GSI_PARTITION = "STATUS#LEAD_NEW";

const StoredLeadSchema = CreateLeadSchema.extend({
  leadId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export interface BackfillLeadsNoticesResult {
  leadsUpserted: number;
  noticesUpserted: number;
  /** Lead ids (or storage keys) that would not read or that Postgres rejected. */
  unreadableLeadIds: string[];
  /** Notice ids (or storage keys) that would not read or that Postgres rejected. */
  unreadableNoticeIds: string[];
}

export interface BackfillLeadsNoticesOptions {
  table: TableClient;
  sql: SqlClient;
  /** Called once per record copied, so a large run is not silent. */
  onProgress?: (label: string, n: number) => void;
}

/**
 * Copies portal leads and notices from Dynamo into the migration 007 tables --
 * the ones `CRM_STORE=postgres` reads -- through the same helpers the live API
 * writes with. Reads Dynamo regardless of `CRM_STORE`.
 *
 * Discovery: leads through the `STATUS#LEAD_NEW` partition of GSI1 (as
 * `listNewLeads` does), notices through the `NOTICE` partition (as
 * `listNotices` does). Both reads drain every page.
 *
 * Idempotent: Dynamo is only read and both writes are upserts on the primary
 * key. Only safe before cutover -- afterwards Postgres holds newer rows a
 * re-run would overwrite. A record that cannot be copied is named in the
 * result, never silently dropped: cutover needs both `unreadable*` lists empty.
 */
export async function backfillLeadsNoticesToPostgres(
  options: BackfillLeadsNoticesOptions,
): Promise<BackfillLeadsNoticesResult> {
  const { table, sql, onProgress } = options;
  const result: BackfillLeadsNoticesResult = {
    leadsUpserted: 0,
    noticesUpserted: 0,
    unreadableLeadIds: [],
    unreadableNoticeIds: [],
  };

  await applyMigrations(sql);

  /** Parse then write one record; name it (and move on) if it is corrupt or Postgres rejects it. */
  async function copyRecord<RecordType>(
    storedItem: TableItem,
    parse: (storedItem: TableItem) => RecordType,
    write: (record: RecordType) => Promise<void>,
    target: { description: string; unreadableIds: string[]; recordId: (storedItem: TableItem) => string },
  ): Promise<boolean> {
    let record: RecordType;
    try {
      record = parse(storedItem);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      console.warn(`Skipping unreadable ${target.description} ${error.recordId}: ${error.reason}`);
      target.unreadableIds.push(error.recordId);
      return false;
    }
    try {
      await write(record);
    } catch (error) {
      if (!isRecordLevelDatabaseError(error)) throw error;
      const recordId = target.recordId(storedItem);
      console.warn(`Skipping ${target.description} ${recordId}: ${describeError(error)}`);
      target.unreadableIds.push(recordId);
      return false;
    }
    return true;
  }

  // --- Leads --------------------------------------------------------------
  for (const leadItem of await table.queryGsi("GSI1", LEAD_GSI_PARTITION)) {
    const copied = await copyRecord<Lead>(
      leadItem,
      (storedItem) =>
        parseStoredRecord(StoredLeadSchema, "Lead", storedRecordId(storedItem, "leadId"), stripStorageKeys(storedItem)),
      (lead) => insertLeadPostgres(sql, lead),
      {
        description: "lead",
        unreadableIds: result.unreadableLeadIds,
        recordId: (storedItem) => storedRecordId(storedItem, "leadId"),
      },
    );
    if (copied) {
      result.leadsUpserted += 1;
      onProgress?.("leads", result.leadsUpserted);
    }
  }

  // --- Notices ------------------------------------------------------------
  for (const noticeItem of await table.query(NOTICE_PARTITION_KEY)) {
    const copied = await copyRecord<Notice>(
      noticeItem,
      (storedItem) =>
        parseStoredRecord(NoticeSchema, "Notice", storedRecordId(storedItem, "noticeId"), stripStorageKeys(storedItem)),
      (notice) => upsertNoticePostgres(sql, notice),
      {
        description: "notice",
        unreadableIds: result.unreadableNoticeIds,
        recordId: (storedItem) => storedRecordId(storedItem, "noticeId"),
      },
    );
    if (copied) {
      result.noticesUpserted += 1;
      onProgress?.("notices", result.noticesUpserted);
    }
  }

  return result;
}
