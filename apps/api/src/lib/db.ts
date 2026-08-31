// env.js MUST be imported first, before @libsql/client. This mirrors the
// exact hazard prisma.ts used to guard against (see git history / RUN.md):
// nothing here has that specific problem today, but this ordering keeps env
// validation as the very first thing that can run in this module's import
// chain, so a missing/invalid env var fails loudly here rather than
// wherever createClient() happens to be reached first.
import { env } from '../config/env.js';
import { createClient, type Client, type InArgs } from '@libsql/client';
import { randomUUID } from 'node:crypto';

/**
 * Direct libSQL/Turso access - no ORM, no migration engine. Same client,
 * same connection, whether DATABASE_URL is a local file (file:./prisma/dev.db)
 * or a real hosted Turso database (libsql://...) with DATABASE_AUTH_TOKEN
 * set - see RUN.md and DEPLOY.md for which mode is which.
 *
 * Schema lives in db/schema.sql as plain SQL, applied by hand (`turso db
 * shell` or the sqlite3 CLI) rather than through a schema-diffing tool -
 * there is no migration history to keep in sync, just that one file as the
 * source of truth for table shape.
 */
export const db: Client = createClient({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN,
});

/** Every primary key in this schema is a plain random UUID, generated here
 * (client-side) rather than by the database - libSQL has no `gen_random_uuid()`. */
export function newId(): string {
  return randomUUID();
}

/** ISO 8601 in UTC, always - the one timestamp format used for every
 * DATETIME column, on both write and (via the row mappers below) read. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs one write statement and returns rows-affected - the raw-SQL
 * equivalent of Prisma's `updateMany`/`deleteMany` count, used the same way
 * call sites already check "did this actually change a row" (e.g. claiming
 * an enrollment code exactly once under a race).
 */
export async function execute(sql: string, args: InArgs = []): Promise<number> {
  const result = await db.execute({ sql, args });
  return Number(result.rowsAffected);
}

/** Runs a query and returns every matching row, raw (no bool/date mapping - see models.ts). */
export async function queryAll<T extends Record<string, unknown>>(sql: string, args: InArgs = []): Promise<T[]> {
  const result = await db.execute({ sql, args });
  return result.rows as unknown as T[];
}

/** Runs a query and returns the first matching row, or null. */
export async function queryOne<T extends Record<string, unknown>>(sql: string, args: InArgs = []): Promise<T | null> {
  const rows = await queryAll<T>(sql, args);
  return rows[0] ?? null;
}

/**
 * Runs several write statements as one atomic transaction - the raw-SQL
 * equivalent of `prisma.$transaction([...])`. Each entry is a fully-formed
 * statement; libSQL's batch API runs them all in a single implicit
 * transaction that rolls back completely if any statement fails.
 */
export async function batch(statements: { sql: string; args: InArgs }[]): Promise<void> {
  await db.batch(
    statements.map((s) => ({ sql: s.sql, args: s.args })),
    'write',
  );
}

/** Fail-fast startup check and readiness probe - both just need the round trip to succeed. */
export async function checkDbConnection(): Promise<void> {
  await db.execute('SELECT 1');
}

/** libSQL's client has no persistent connection to tear down like Prisma's did, but closing releases its internal resources on shutdown. */
export function disconnectDb(): void {
  db.close();
}
