import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/crypto.js';

/**
 * Development convenience only. Creates one verified demo account so a fresh
 * environment can be logged into immediately, without exercising the email
 * flow. Never runs against production (see the guard below).
 */
const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@minedesk.local';
const DEMO_PASSWORD = 'CorrectHorseBattery9';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: 'Demo User',
      emailVerified: true,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'Seeded demo account:',
      `  email:    ${user.email}`,
      `  password: ${DEMO_PASSWORD}`,
      '',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
