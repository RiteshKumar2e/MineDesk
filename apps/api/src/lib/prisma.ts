import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * A single PrismaClient per process. In development, tsx watch reloads the
 * module graph on every save, so the instance is parked on globalThis to avoid
 * exhausting the Postgres connection pool with orphaned clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (!env.isProduction) globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
