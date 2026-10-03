import { crm, type Traveller } from "@rgs/shared";
import { PGlite } from "@electric-sql/pglite";
import type { AppContext } from "../src/lib/context";
import { InMemoryTableClient } from "../src/lib/db";
import { InMemoryDocumentStore } from "../src/lib/documentStore";
import { InMemoryEmailSender } from "../src/lib/email";
import type { SqlClient, SqlQueryable, SqlQueryResult } from "../src/lib/sql";
import { createDraft, patchDraft } from "../src/domain/applications";
import { recordDocumentUpload } from "../src/domain/documents";
import { META_SORT_KEY, statusEmailTemplatePartitionKey } from "../src/domain/crm/keys";
import { seedStatusEmailTemplatesIfAbsent } from "../src/domain/crm/statusEmailTemplates";
import { applyMigrations } from "../src/db/migrate";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

export interface TestContext extends AppContext {
  table: InMemoryTableClient;
  documents: InMemoryDocumentStore;
  email: InMemoryEmailSender;
  advanceClock(milliseconds: number): void;
}

/** The tenant every CRM test runs as. */
const TEST_TENANT_ID = "rgs";

export interface BuildTestContextOptions {
  /**
   * Seed the built-in status email templates for the `rgs` tenant (default
   * true), so create + status-change mail works in every test without each
   * one seeding first. Pass false to test the seed itself or the
   * "no template stored" path.
   */
  seedStatusEmailTemplates?: boolean;
}

/**
 * `buildTestContext` is synchronous, so this cannot await
 * `seedStatusEmailTemplatesIfAbsent`. `InMemoryTableClient.put` has no `await`
 * in its body, so it mutates the map during the call itself; firing the puts
 * un-awaited therefore leaves every row in place before the caller gets the
 * context.
 */
function seedStatusEmailTemplatesNow(table: InMemoryTableClient): void {
  for (const caseStatus of crm.CASE_STATUSES) {
    const template: crm.StatusEmailTemplate = {
      tenantId: TEST_TENANT_ID,
      caseStatus,
      ...crm.defaultStatusEmailTemplate(caseStatus),
      updatedAt: "2026-07-23T10:00:00.000Z",
      updatedBy: "seed@rgs.local",
    };
    void table.put({
      PK: statusEmailTemplatePartitionKey(TEST_TENANT_ID, caseStatus),
      SK: META_SORT_KEY,
      ...template,
    });
  }
}

export function buildTestContext(options: BuildTestContextOptions = {}): TestContext {
  let currentTimeMs = new Date("2026-07-23T10:00:00.000Z").getTime();
  const table = new InMemoryTableClient();
  if (options.seedStatusEmailTemplates !== false) seedStatusEmailTemplatesNow(table);
  return {
    table,
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date(currentTimeMs),
    advanceClock(milliseconds: number) {
      currentTimeMs += milliseconds;
    },
  };
}

export interface SqlTestContext extends AppContext {
  sql: SqlClient;
  documents: InMemoryDocumentStore;
  email: InMemoryEmailSender;
  advanceClock(milliseconds: number): void;
}

const openSqlContexts = new Set<SqlTestContext>();

/** Close every PGlite opened by `buildSqlTestContext`; wire into `afterEach`. */
export async function closeSqlTestContexts(): Promise<void> {
  const open = [...openSqlContexts];
  openSqlContexts.clear();
  await Promise.all(open.map((context) => context.sql.end().catch(() => undefined)));
}

export async function buildSqlTestContext(
  options: BuildTestContextOptions = {},
): Promise<SqlTestContext> {
  const database = new PGlite();
  const sql = pgliteAsSqlClient(database);
  await applyMigrations(sql);

  let currentTimeMs = new Date("2026-07-23T10:00:00.000Z").getTime();
  const context: SqlTestContext = {
    table: new InMemoryTableClient(),
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date(currentTimeMs),
    advanceClock(milliseconds: number) {
      currentTimeMs += milliseconds;
    },
    crmStore: "postgres",
    ledgerStore: "postgres",
    sql,
  };

  openSqlContexts.add(context);
  if (options.seedStatusEmailTemplates !== false) {
    await seedStatusEmailTemplatesIfAbsent(context, "rgs", "seed@rgs.local");
  }
  return context;
}

/** Tables a case's own data lives in; a write tool must not touch them before approval. */
const CASE_WRITE_PATTERN =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:crm_cases|crm_applicants|crm_events|crm_ref_claims|crm_case_ref_reservations)\b/i;

/** Any statement that changes data. */
const ANY_WRITE_PATTERN = /\b(?:insert\s+into|delete\s+from|update\s+[a-z_]+\s+set|truncate)\b/i;

function contextRefusingSql<Context extends AppContext & { sql: SqlClient }>(
  context: Context,
  pattern: RegExp,
  describeViolation: (statement: string) => string,
): Context {
  const guard = (text: string): void => {
    if (pattern.test(text)) throw new Error(describeViolation(text.trim().slice(0, 80)));
  };
  const guardQueryable = (inner: SqlQueryable): SqlQueryable => ({
    query: (text, values) => {
      guard(text);
      return inner.query(text, values);
    },
  });
  const sql: SqlClient = {
    ...guardQueryable(context.sql),
    transaction: (work) => context.sql.transaction((tx) => work(guardQueryable(tx))),
    end: () => context.sql.end(),
  };
  return { ...context, sql };
}

/**
 * Wraps a context's SQL client so any write to a case table throws at once,
 * while staging a proposal (a legitimate write to `crm_proposals`) passes
 * through untouched. This is the SQL form of the "write tools stage, never
 * apply" invariant: the guarded run must leave the case rows exactly as they
 * were before approval.
 */
export function contextRefusingCaseWrites<Context extends AppContext & { sql: SqlClient }>(
  context: Context,
  toolNameForMessage: string,
): Context {
  return contextRefusingSql(
    context,
    CASE_WRITE_PATTERN,
    (statement) =>
      `INVARIANT VIOLATED: write tool "${toolNameForMessage}" wrote a case before approval (${statement})`,
  );
}

/** Wraps a context's SQL client so reads work but any data-changing statement throws (`execute` must propose, never write). */
export function contextRefusingWrites<Context extends AppContext & { sql: SqlClient }>(
  context: Context,
  toolNameForMessage: string,
): Context {
  return contextRefusingSql(
    context,
    ANY_WRITE_PATTERN,
    (statement) => `tool "${toolNameForMessage}"'s execute attempted a write (${statement})`,
  );
}

export type SqlInterceptor = (
  statement: { text: string; values: readonly unknown[] },
  run: () => Promise<SqlQueryResult>,
) => Promise<SqlQueryResult>;

/**
 * Fault injection: replaces `context.sql` in place with a client whose every
 * statement (pool or transaction) passes through `interceptor`, which may
 * throw, observe, or run extra work before/after calling `run()`.
 */
export function interceptSql(context: { sql: SqlClient }, interceptor: SqlInterceptor): void {
  const inner = context.sql;
  const wrap = (queryable: SqlQueryable): SqlQueryable => ({
    query: ((text: string, values: readonly unknown[] = []) =>
      interceptor({ text, values }, () =>
        queryable.query(text, values),
      )) as SqlQueryable["query"],
  });
  context.sql = {
    ...wrap(inner),
    transaction: (work) => inner.transaction((tx) => work(wrap(tx))),
    end: () => inner.end(),
  };
}

export const completeTraveller: Traveller = {
  fullName: "Asha Verma",
  dateOfBirth: "1992-04-18",
  nationality: "IN",
  passportNumber: "N1234567",
  passportIssueDate: "2020-01-10",
  passportExpiryDate: "2030-01-09",
};

export const completeEssentials = {
  intendedTravelDate: "2026-08-20",
  purposeOfTravel: "Tourism",
  contactPhone: "+919810000000",
  residentialAddress: "42 Green Park, New Delhi",
};

/** Creates a UAE draft filled to the point where submission should succeed. */
export async function createSubmittableUaeDraft(
  context: AppContext,
  userId = "user_1",
): Promise<string> {
  const userEmail = `${userId}@example.com`;
  const draft = await createDraft(context, userId, "AE", userEmail);
  await patchDraft(
    context,
    userId,
    draft.applicationId,
    {
      travellers: [completeTraveller],
      essentials: completeEssentials,
      stepReached: "review",
    },
    userEmail,
  );
  for (const docType of ["PASSPORT_BIO", "PHOTO"] as const) {
    await recordDocumentUpload(
      context,
      userId,
      draft.applicationId,
      docType,
      0,
      `applications/${draft.applicationId}/traveller-0/${docType}.jpg`,
      userEmail,
    );
  }
  return draft.applicationId;
}
