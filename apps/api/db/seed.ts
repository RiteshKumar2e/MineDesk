import { execute, newId, nowIso, queryOne } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/crypto.js';

/**
 * Development convenience only. Creates one verified demo account so a fresh
 * environment can be logged into immediately, without exercising the email
 * flow. Never runs against production (see the guard below).
 */
const DEMO_EMAIL = 'demo@minedesk.local';
const DEMO_PASSWORD = 'CorrectHorseBattery9';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ?', [DEMO_EMAIL]);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  if (existing) {
    await execute('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?', [
      passwordHash,
      nowIso(),
      existing.id,
    ]);
  } else {
    const timestamp = nowIso();
    await execute(
      `INSERT INTO users (id, email, passwordHash, name, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [newId(), DEMO_EMAIL, passwordHash, 'Demo User', timestamp, timestamp],
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    ['', 'Seeded demo account:', `  email:    ${DEMO_EMAIL}`, `  password: ${DEMO_PASSWORD}`, ''].join('\n'),
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
