import { randomInt } from 'crypto';
import { initDB, queryOne, runSQL, closePool } from './schema';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

// Ambiguous glyphs (0/O, 1/l/I) are excluded so a generated password can be
// read aloud or copied from a terminal without guessing.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 24;

function generatePassword(length = PASSWORD_LENGTH): string {
  // randomInt, not `randomBytes[i] % ALPHABET.length`: 256 is not a multiple of
  // this alphabet's size, so the modulo operator would make the first 28 glyphs
  // measurably more likely than the rest.
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

interface SeededAccount {
  username: string;
  email: string;
  role: string;
  password: string;
}

async function seed() {
  await initDB();

  const existing = await queryOne('SELECT id FROM users WHERE role = ?', ['super_admin']);
  if (existing) {
    console.log('Database already seeded. No accounts created.');
    return;
  }

  // Passwords are generated, never hardcoded, and printed exactly once. A
  // password committed to the repo is a known password, so there is no
  // "temporary" default to forget to change.
  const accounts: SeededAccount[] = [
    { username: 'superadmin', email: 'superadmin@audio.com', role: 'super_admin' },
    { username: 'admin', email: 'admin@audio.com', role: 'admin' },
  ].map((a) => ({ ...a, password: generatePassword() }));

  for (const account of accounts) {
    await runSQL(
      'INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [
        uuidv4(),
        account.username,
        account.email,
        bcrypt.hashSync(account.password, 12),
        account.role,
      ]
    );
  }

  console.log('\n============================================================');
  console.log(' Seeded accounts — these passwords are shown ONCE. Store them now.');
  console.log('============================================================');
  for (const a of accounts) {
    console.log(` role    : ${a.role}`);
    console.log(` username: ${a.username}`);
    console.log(` email   : ${a.email}`);
    console.log(` password: ${a.password}`);
    console.log('------------------------------------------------------------');
  }
}

seed()
  .then(() => closePool())
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  });
