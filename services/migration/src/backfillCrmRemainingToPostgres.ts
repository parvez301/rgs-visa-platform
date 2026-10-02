import { ProposedChangeSchema } from "@rgs/api/src/agent/proposedChangeSchema";
import type { ProposedChange } from "@rgs/api/src/agent/approval";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { writeCaseRefReservationPostgres } from "@rgs/api/src/domain/crm/caseRefIndexPostgres";
import type { CaseRefReservation } from "@rgs/api/src/domain/crm/caseRefIndex";
import {
  CRM_USER_PREFS_SORT_KEY,
  META_SORT_KEY,
  caseRefIndexPartitionKey,
  caseStatusGsi1Pk,
  crmUserPrefsPartitionKey,
  memoryPartitionKey,
  partnerListGsi1Pk,
  proposalStatusGsi1Pk,
  reviewQueueGsi1Pk,
  statusEmailTemplatePartitionKey,
} from "@rgs/api/src/domain/crm/keys";
import { upsertMemoryPostgres } from "@rgs/api/src/domain/crm/memoryPostgres";
import { writeUserPrefsPostgres } from "@rgs/api/src/domain/crm/prefsPostgres";
import { upsertProposalPostgres } from "@rgs/api/src/domain/crm/proposalsPostgres";
import { insertReviewItemPostgres } from "@rgs/api/src/domain/crm/reviewQueuePostgres";
import { upsertStatusEmailTemplatePostgres } from "@rgs/api/src/domain/crm/statusEmailTemplatesPostgres";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { parseStoredRecord, storedRecordId, stripStorageKeys } from "@rgs/api/src/lib/storedRecords";
import { crm } from "@rgs/shared";
import { z } from "zod";

export interface BackfillCrmRemainingResult {
  reservationsUpserted: number;
  reviewItemsUpserted: number;
  proposalsUpserted: number;
  memoriesUpserted: number;
  prefsUpserted: number;
  templatesUpserted: number;
  /** caseRefs whose reservation item would not parse, or that Postgres rejected. */
  unreadableReservationIds: string[];
  unreadableReviewItemIds: string[];
  unreadableProposalIds: string[];
  unreadableMemoryKeys: string[];
  unreadablePrefsEmails: string[];
  /** Case statuses whose template item would not parse, or that Postgres rejected. */
  unreadableTemplateStatuses: string[];
}

export interface BackfillCrmRemainingOptions {
  table: TableClient;
  sql: SqlClient;
  tenantId: string;
  /**
   * Emails to look up user prefs and USER-scope memories for, on top of the
   * ones found in the data. Dynamo has no "list all users" access path for
   * either, so an email nothing else mentions can only be reached if named.
   */
  extraEmails?: readonly string[];
  /** Called once per record copied, labelled by domain, so a large run is not silent. */
  onProgress?: (label: string, n: number) => void;
}

const CaseRefReservationSchema = z.object({
  tenantId: z.string().min(1),
  caseRef: z.string().min(1),
  caseId: z.string().min(1),
  reservedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

const PROPOSAL_STATUSES = ["PENDING", "APPROVED", "DISCARDED"] as const;

/**
 * SQLSTATE class 22 (data exception: overflow, bad cast) and class 23
 * (integrity/check). Properties of one record, so it is named and the run
 * goes on. Anything else -- a dropped connection, a missing table -- is not
 * about the record and aborts.
 */
export function isRecordLevelDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlState = (error as { code?: unknown }).code;
  return typeof sqlState === "string" && (sqlState.startsWith("22") || sqlState.startsWith("23"));
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CopyDomain<RecordType> {
  /** Progress label, and what a warning calls one record. */
  label: string;
  entityDescription: string;
  unreadableIds: string[];
  /** The id a warning and the unreadable list name this record by. */
  recordId: (storedItem: TableItem) => string;
  parse: (storedItem: TableItem) => RecordType;
  write: (record: RecordType) => Promise<void>;
}

/**
 * Parses and writes each stored item. A parse failure (CorruptRecordError) or a
 * record-level Postgres rejection names the record and moves on; anything else
 * propagates. Returns the parsed records that were written.
 */
async function copyItems<RecordType>(
  storedItems: readonly TableItem[],
  domain: CopyDomain<RecordType>,
  onProgress: BackfillCrmRemainingOptions["onProgress"],
  counter: { n: number },
): Promise<RecordType[]> {
  const written: RecordType[] = [];
  for (const storedItem of storedItems) {
    let record: RecordType;
    try {
      record = domain.parse(storedItem);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      domain.unreadableIds.push(error.recordId);
      console.warn(`Skipping unreadable ${domain.entityDescription} ${error.recordId}: ${error.reason}`);
      continue;
    }
    try {
      await domain.write(record);
    } catch (error) {
      if (!isRecordLevelDatabaseError(error)) throw error;
      const recordId = domain.recordId(storedItem);
      domain.unreadableIds.push(recordId);
      console.warn(`Postgres rejected ${domain.entityDescription} ${recordId}: ${describeError(error)}`);
      continue;
    }
    counter.n += 1;
    written.push(record);
    onProgress?.(domain.label, counter.n);
  }
  return written;
}

/** Same as `storedRecordId`, but tries each attribute name in turn. */
function idOf(storedItem: TableItem, ...idAttributeNames: string[]): string {
  for (const name of idAttributeNames) {
    const value = storedItem[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return storedRecordId(storedItem, idAttributeNames[0] ?? "id");
}

/**
 * Copies the remaining Dynamo CRM data into the Postgres tables
 * `CRM_STORE=postgres` reads (migration 004): case ref reservations, review
 * items, agent proposals, memories, user prefs and status email templates.
 * Reads Dynamo regardless of `CRM_STORE`.
 *
 * Discovery follows how each domain lists today:
 *  - review items: GSI1 per review status.
 *  - proposals: GSI1 per proposal status.
 *  - templates: one base-table get per case status.
 *  - memories: base-table partition per scope -- ORG, PARTNER#<each partner
 *    in the partner list GSI1>, USER#<each known email>.
 *  - prefs: one get per known email.
 *  - reservations: one consistent get per caseRef -- the caseRefs of every
 *    case (GSI1 per case status) and review item. A reservation for a ref no
 *    case or review item mentions (an import that died before writing
 *    anything) has no access path in Dynamo and is not reachable.
 *  - "known emails": `extraEmails`, case/partner creators, proposal
 *    proposers/deciders, review resolvers and memory authors.
 *
 * Idempotent: every write is an upsert on the primary key. Only safe before
 * cutover -- afterwards Postgres holds newer rows a re-run would overwrite
 * with Dynamo's stale copies.
 *
 * A record that cannot be copied is named in the result, never silently
 * dropped: cutover needs every `unreadable*` list empty.
 */
export async function backfillCrmRemainingToPostgres(
  options: BackfillCrmRemainingOptions,
): Promise<BackfillCrmRemainingResult> {
  const { table, sql, tenantId, onProgress } = options;
  const result: BackfillCrmRemainingResult = {
    reservationsUpserted: 0,
    reviewItemsUpserted: 0,
    proposalsUpserted: 0,
    memoriesUpserted: 0,
    prefsUpserted: 0,
    templatesUpserted: 0,
    unreadableReservationIds: [],
    unreadableReviewItemIds: [],
    unreadableProposalIds: [],
    unreadableMemoryKeys: [],
    unreadablePrefsEmails: [],
    unreadableTemplateStatuses: [],
  };
  const knownEmails = new Set<string>(options.extraEmails ?? []);
  const caseRefs = new Set<string>();
  const addEmail = (email: unknown): void => {
    if (typeof email === "string" && email.length > 0) knownEmails.add(email);
  };

  await applyMigrations(sql);

  // Review items
  const reviewItems: crm.ReviewItem[] = [];
  const reviewCounter = { n: 0 };
  for (const reviewStatus of crm.REVIEW_STATUSES) {
    const storedItems = await table.queryGsi("GSI1", reviewQueueGsi1Pk(tenantId, reviewStatus));
    reviewItems.push(
      ...(await copyItems(
        storedItems,
        {
          label: "reviewItems",
          entityDescription: "review item",
          unreadableIds: result.unreadableReviewItemIds,
          recordId: (storedItem) => idOf(storedItem, "reviewItemId"),
          parse: (storedItem) =>
            parseStoredRecord(
              crm.ReviewItemSchema,
              "Review item",
              idOf(storedItem, "reviewItemId"),
              stripStorageKeys(storedItem),
            ),
          write: (reviewItem) => insertReviewItemPostgres(sql, { ...reviewItem, tenantId }),
        },
        onProgress,
        reviewCounter,
      )),
    );
  }
  result.reviewItemsUpserted = reviewCounter.n;
  for (const reviewItem of reviewItems) {
    caseRefs.add(reviewItem.caseRef);
    addEmail(reviewItem.resolvedBy);
  }

  // Proposals
  const proposalCounter = { n: 0 };
  for (const status of PROPOSAL_STATUSES) {
    const storedItems = await table.queryGsi("GSI1", proposalStatusGsi1Pk(tenantId, status));
    const proposals = await copyItems<ProposedChange>(
      storedItems,
      {
        label: "proposals",
        entityDescription: "agent proposal",
        unreadableIds: result.unreadableProposalIds,
        recordId: (storedItem) => idOf(storedItem, "proposalId"),
        parse: (storedItem) =>
          parseStoredRecord(
            ProposedChangeSchema,
            "Agent proposal",
            idOf(storedItem, "proposalId"),
            stripStorageKeys(storedItem),
          ),
        write: (proposal) => upsertProposalPostgres(sql, tenantId, proposal),
      },
      onProgress,
      proposalCounter,
    );
    for (const proposal of proposals) {
      addEmail(proposal.proposedBy);
      addEmail(proposal.decidedBy);
    }
  }
  result.proposalsUpserted = proposalCounter.n;

  // Partners (for PARTNER# scopes and creator emails) and cases (for caseRefs and creator emails).
  const partnerIds: string[] = [];
  for (const partnerItem of await table.queryGsi("GSI1", partnerListGsi1Pk(tenantId))) {
    if (partnerItem.SK !== META_SORT_KEY) continue;
    const partnerId = idOf(partnerItem, "partnerId");
    partnerIds.push(partnerId);
    addEmail(partnerItem["createdByEmail"]);
  }
  for (const caseStatus of crm.CASE_STATUSES) {
    const caseItems = await table.queryGsi("GSI1", caseStatusGsi1Pk(tenantId, caseStatus), {
      projection: ["PK", "SK", "caseRef", "createdByEmail"],
    });
    for (const caseItem of caseItems) {
      if (caseItem.SK !== META_SORT_KEY) continue;
      const caseRef = caseItem["caseRef"];
      if (typeof caseRef === "string" && caseRef.length > 0) caseRefs.add(caseRef);
      addEmail(caseItem["createdByEmail"]);
    }
  }

  // Memories: ORG and PARTNER# first, whose authors widen the known emails, then USER#.
  const memoryCounter = { n: 0 };
  const copyScope = async (scope: string): Promise<void> => {
    const storedItems = await table.query(memoryPartitionKey(tenantId, scope), { consistentRead: true });
    const memories = await copyItems<crm.CrmMemory>(
      storedItems,
      {
        label: "memories",
        entityDescription: "CRM memory",
        unreadableIds: result.unreadableMemoryKeys,
        recordId: (storedItem) => idOf(storedItem, "memoryKey"),
        parse: (storedItem) =>
          parseStoredRecord(
            crm.CrmMemorySchema,
            "CRM memory",
            idOf(storedItem, "memoryKey"),
            stripStorageKeys(storedItem),
          ),
        write: (memory) => upsertMemoryPostgres(sql, { ...memory, tenantId }),
      },
      onProgress,
      memoryCounter,
    );
    for (const memory of memories) addEmail(memory.createdByEmail);
  };
  await copyScope("ORG");
  for (const partnerId of partnerIds) await copyScope(`PARTNER#${partnerId}`);
  for (const email of [...knownEmails]) await copyScope(`USER#${email}`);
  result.memoriesUpserted = memoryCounter.n;

  // User prefs
  const prefsCounter = { n: 0 };
  for (const email of knownEmails) {
    const prefsItem = await table.get(crmUserPrefsPartitionKey(tenantId, email), CRM_USER_PREFS_SORT_KEY, {
      consistentRead: true,
    });
    if (prefsItem === undefined) continue;
    await copyItems<crm.CrmUserPrefs>(
      [prefsItem],
      {
        label: "prefs",
        entityDescription: "CRM user prefs",
        unreadableIds: result.unreadablePrefsEmails,
        recordId: () => email,
        parse: (storedItem) =>
          parseStoredRecord(crm.CrmUserPrefsSchema, "CRM user prefs", email, stripStorageKeys(storedItem)),
        write: (prefs) => writeUserPrefsPostgres(sql, { ...prefs, tenantId }),
      },
      onProgress,
      prefsCounter,
    );
  }
  result.prefsUpserted = prefsCounter.n;

  // Status email templates
  const templateCounter = { n: 0 };
  for (const caseStatus of crm.CASE_STATUSES) {
    const templateItem = await table.get(statusEmailTemplatePartitionKey(tenantId, caseStatus), META_SORT_KEY, {
      consistentRead: true,
    });
    if (templateItem === undefined) continue;
    await copyItems<crm.StatusEmailTemplate>(
      [templateItem],
      {
        label: "templates",
        entityDescription: "status email template",
        unreadableIds: result.unreadableTemplateStatuses,
        recordId: () => caseStatus,
        parse: (storedItem) =>
          parseStoredRecord(
            crm.StatusEmailTemplateSchema,
            "StatusEmailTemplate",
            caseStatus,
            stripStorageKeys(storedItem),
          ),
        write: (template) => upsertStatusEmailTemplatePostgres(sql, { ...template, tenantId }),
      },
      onProgress,
      templateCounter,
    );
  }
  result.templatesUpserted = templateCounter.n;

  // Reservations
  const reservationCounter = { n: 0 };
  for (const caseRef of caseRefs) {
    const reservationItem = await table.get(caseRefIndexPartitionKey(tenantId, caseRef), META_SORT_KEY, {
      consistentRead: true,
    });
    if (reservationItem === undefined) continue;
    await copyItems<CaseRefReservation>(
      [reservationItem],
      {
        label: "reservations",
        entityDescription: "case ref reservation",
        unreadableIds: result.unreadableReservationIds,
        recordId: () => caseRef,
        parse: (storedItem) =>
          parseStoredRecord(CaseRefReservationSchema, "Case ref reservation", caseRef, stripStorageKeys(storedItem)),
        write: (reservation) => writeCaseRefReservationPostgres(sql, { ...reservation, tenantId }),
      },
      onProgress,
      reservationCounter,
    );
  }
  result.reservationsUpserted = reservationCounter.n;

  return result;
}
