// env.js MUST be imported first, before @prisma/client. Merely importing
// @prisma/client has a side effect of auto-loading apps/api/prisma/.env
// (Prisma CLI's own env file, which intentionally holds a *different*,
// schema-directory-relative DATABASE_URL - see that file's comment) into
// process.env, and dotenv does not override a variable that is already set.
// Importing env.js first means its own explicit, correct load of the repo
// root .env (cwd-relative DATABASE_URL) runs and validates first, so
// Prisma's later auto-load of the other file becomes a harmless no-op
// instead of silently winning depending on which module happens to import
// @prisma/client first across the whole app - confirmed to actually happen
// (and break) before this fix, not just a theoretical risk.
import { env } from '../config/env.js';
import { createClient } from '@libsql/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

/**
 * The libSQL client speaks to both a local file (DATABASE_URL=
 * file:./prisma/dev.db, DATABASE_AUTH_TOKEN unset) and a real hosted Turso
 * database (DATABASE_URL=libsql://<name>.turso.io, DATABASE_AUTH_TOKEN set) -
 * same client, same code path, so there is nothing environment-specific to
 * branch on here. See RUN.md for which mode to use when.
 */
const libsql = createClient({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN,
});
const adapter = new PrismaLibSQL(libsql);

/**
 * A single PrismaClient per process. In development, tsx watch reloads the
 * module graph on every save, so the instance is parked on globalThis to avoid
 * exhausting the connection pool with orphaned clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (!env.isProduction) globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
