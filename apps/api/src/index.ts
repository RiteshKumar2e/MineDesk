import { buildApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { disconnectRedis, redis } from './lib/redis.js';
import { hub } from './modules/signaling/hub.js';

async function main(): Promise<void> {
  // Fail fast if the database or Redis are unreachable, rather than accepting
  // traffic into a process that cannot actually serve it.
  await prisma.$connect();
  await redis.ping();

  const app = await buildApp();

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(
    { port: env.API_PORT, env: env.NODE_ENV, nodeId: hub.nodeId },
    'MineDesk API listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    // Close signaling sockets first so clients reconnect elsewhere instead of
    // hanging on a server that is about to disappear.
    hub.closeAll(1001, 'server restarting');

    await app.close();
    await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
