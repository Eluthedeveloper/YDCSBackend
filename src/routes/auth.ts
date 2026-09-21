import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, runSQL } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin } from '../middleware/auth';

const router = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['admin', 'super_admin'] as const;

function signToken(user: { id: string; username: string; role: string; token_version: number }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tokenVersion: user.token_version },
    secret,
    { expiresIn: '24h' }
  );
}

async function bumpTokenVersion(userId: string) {
  await runSQL('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
}

router.post('/login', async (req, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]) as any;

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await queryOne('SELECT id, username, email, role, created_at FROM users WHERE id = ?', [req.user!.id]);
    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.put('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let passwordChanged = false;

    if (!username && !email && !password) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (username) {
      if (typeof username !== 'string' || username.trim().length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      const existing = await queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.user!.id]) as any;
      if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      updates.push('username = ?');
      values.push(username.trim());
    }

    if (email) {
      if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user!.id]) as any;
      if (existing) {
        return res.status(400).json({ error: 'Email already taken' });
      }
      updates.push('email = ?');
      values.push(email.trim());
    }

    if (password) {
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updates.push('password = ?');
      values.push(await bcrypt.hash(password, 10));
      passwordChanged = true;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user!.id);
    await runSQL(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    const updatedUser = await queryOne('SELECT id, username, email, role, token_version FROM users WHERE id = ?', [req.user!.id]) as any;

    // Changing your own password revokes old sessions; issue a fresh token so
    // the current session stays logged in.
    let token: string | undefined;
    if (passwordChanged) {
      await bumpTokenVersion(req.user!.id);
      updatedUser.token_version += 1;
      token = signToken(updatedUser);
    }

    res.json({ ...updatedUser, token });
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.get('/', authenticate, requireSuperAdmin, async (_req, res: Response) => {
  try {
    const users = await queryAll('SELECT id, username, email, role, created_at FROM users');
    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post('/', authenticate, requireSuperAdmin, async (req, res: Response) => {
  const { username, email, password, role } = req.body;

  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (!EMAIL_REGEX.test(email || '')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await runSQL('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [id, username.trim(), email.trim(), hashedPassword, role]);
    res.json({ id, username: username.trim(), email: email.trim(), role });
  } catch (err: any) {
    res.status(400).json({ error: 'User already exists' });
  }
});

router.put('/:id/password', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  const { password } = req.body;
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const targetUser = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]) as any;
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await runSQL('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?', [hashedPassword, req.params.id]);
  res.json({ message: 'Password updated' });
});

router.delete('/:id', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  await runSQL('UPDATE programs SET created_by = ? WHERE created_by = ?', [req.user!.id, req.params.id]);
  await runSQL('UPDATE tracks SET created_by = ? WHERE created_by = ?', [req.user!.id, req.params.id]);
  await runSQL('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'User deleted' });
});

export default router;