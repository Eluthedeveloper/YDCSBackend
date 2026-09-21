import { initDB, queryOne, runSQL } from './schema';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  await initDB();
  const existing = await queryOne('SELECT id FROM users WHERE role = ?', ['super_admin']);
  if (existing) {
    console.log('Database already seeded.');
    return;
  }

  const superAdminId = uuidv4();
  const adminId = uuidv4();
  const superAdminHash = bcrypt.hashSync('superadmin123', 10);
  const adminHash = bcrypt.hashSync('admin123', 10);

  await runSQL('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)',
    [superAdminId, 'superadmin', 'superadmin@audio.com', superAdminHash, 'super_admin']);

  await runSQL('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)',
    [adminId, 'admin', 'admin@audio.com', adminHash, 'admin']);

  console.log('Seed completed!');
  console.log('Super Admin credentials generated - check database for details');
}

seed();
