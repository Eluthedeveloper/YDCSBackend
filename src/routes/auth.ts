import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, runSQL, withTransaction, type SqlParam } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, ROLES } from '../middleware/auth';
import { asyncHandler } from '../lib/asyncHandler';
import { clearAuthCookie, setAuthCookie, TOKEN_TTL_SECONDS } from '../lib/authCookie';

const router = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;

interface UserRow {
  id: string;
  username: string;
  email: string;
  role: 'super_admin' | 'admin';
}

interface SeededUserRow extends UserRow {
  password: string;
  token_version: number;
}

function publicUser(user: Partial<UserRow>) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  };
}

function signToken(user: { id: string; username: string; role: string; token_version: number }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tokenVersion: user.token_version },
    secret,
    { expiresIn: TOKEN_TTL_SECONDS }
  );
}

function validateCredentials(username: unknown, email: unknown, password: unknown) {
  if (typeof username !== 'string' || username.trim().length < 3) {
    return 'Username must be at least 3 characters';
  }
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return 'Invalid email address';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

router.post('/login', asyncHandler(async (req, res: Response) => {
  const { username, password } = req.body ?? {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = await queryOne<SeededUserRow>('SELECT * FROM users WHERE username = ?', [username]);

  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  setAuthCookie(res, signToken(user));
  // The token is deliberately not in the response body: it lives only in an
  // httpOnly cookie so injected script cannot read it.
  res.json({ user: publicUser(user) });
}));

router.post('/logout', (_req, res: Response) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out' });
});

router.get('/me', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await queryOne(
    'SELECT id, username, email, role, created_at FROM users WHERE id = ?',
    [req.user!.id]
  );
  res.json(user);
}));

router.put('/me', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { username, email, password } = req.body ?? {};

  if (!username && !email && !password) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const updates: string[] = [];
  const values: SqlParam[] = [];

  if (username !== undefined) {
    if (typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    const existing = await queryOne(
      'SELECT id FROM users WHERE username = ? AND id != ?',
      [username.trim(), req.user!.id]
    );
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    updates.push('username = ?');
    values.push(username.trim());
  }

  if (email !== undefined) {
    if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    const existing = await queryOne(
      'SELECT id FROM users WHERE email = ? AND id != ?',
      [email.trim(), req.user!.id]
    );
    if (existing) {
      return res.status(400).json({ error: 'Email already taken' });
    }
    updates.push('email = ?');
    values.push(email.trim());
  }

  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    updates.push('password = ?');
    values.push(await bcrypt.hash(password, BCRYPT_ROUNDS));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  // Bumping token_version revokes every other session for this user. Done in the
  // same transaction as the update so a revoked session can never outlive a
  // failed password change.
  const updatedUser = await withTransaction(async (conn) => {
    if (password !== undefined) {
      await conn.execute(
        `UPDATE users SET ${updates.join(', ')}, token_version = token_version + 1 WHERE id = ?`,
        [...values, req.user!.id]
      );
    } else {
      await conn.execute(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        [...values, req.user!.id]
      );
    }

    const [rows] = await conn.execute(
      'SELECT id, username, email, role, token_version FROM users WHERE id = ?',
      [req.user!.id]
    );
    return (rows as (UserRow & { token_version: number })[])[0];
  });

  // Keep the caller signed in after their own password change by re-issuing a
  // cookie against the bumped version.
  if (password !== undefined) {
    setAuthCookie(res, signToken(updatedUser));
  }

  res.json(publicUser(updatedUser));
}));

router.get('/', authenticate, requireSuperAdmin, asyncHandler(async (_req, res: Response) => {
  const users = await queryAll('SELECT id, username, email, role, created_at FROM users');
  res.json(users);
}));

router.post('/', authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const { username, email, password, role } = req.body ?? {};

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const invalid = validateCredentials(username, email, password);
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password as string, BCRYPT_ROUNDS);

  try {
    await runSQL('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [id, (username as string).trim(), (email as string).trim(), hashedPassword, role]);
    res.status(201).json(publicUser({ id, username, email, role }));
  } catch (err: any) {
    if (err?.errno === 1062) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
}));

router.put('/:id/password', authenticate, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const targetUser = await queryOne('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // Bumping token_version here is what actually logs the target user out.
  await runSQL('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?',
    [hashedPassword, req.params.id]);
  res.json({ message: 'Password updated' });
}));

router.delete('/:id', authenticate, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  const targetUser = await queryOne('SELECT id, username FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  // programs.created_by / tracks.created_by are NOT NULL with ON DELETE RESTRICT,
  // and every listing inner-joins users on that column. Reassigning would
  // silently misattribute someone else's work and nulling would hide their
  // content entirely, so the delete is refused until the content is gone.
  const owned = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM programs WHERE created_by = ?) as programs,
       (SELECT COUNT(*) FROM tracks   WHERE created_by = ?) as tracks`,
    [req.params.id, req.params.id]
  ) as { programs: number; tracks: number } | undefined;

  if ((owned?.programs ?? 0) > 0 || (owned?.tracks ?? 0) > 0) {
    return res.status(409).json({
      error: 'Cannot delete a user who still owns content',
      detail: `Delete or reassign their ${owned!.programs} program(s) and ${owned!.tracks} track(s) first`,
      programs: owned!.programs,
      tracks: owned!.tracks,
    });
  }

  await runSQL('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'User deleted' });
}));

export default router;
