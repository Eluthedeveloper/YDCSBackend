import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { queryOne } from '../database/schema';
import { asyncHandler } from '../lib/asyncHandler';
import { readToken, setAuthCookie, TOKEN_TTL_SECONDS } from '../lib/authCookie';

export interface AuthUser {
  id: string;
  username: string;
  role: 'super_admin' | 'admin';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const ROLES: readonly AuthUser['role'][] = ['super_admin', 'admin'];

interface TokenPayload extends JwtPayload {
  id: string;
  username: string;
  role: AuthUser['role'];
  tokenVersion: number;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('JWT_SECRET is missing');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  let decoded: TokenPayload;
  try {
    decoded = jwt.verify(token, secret) as TokenPayload;

    if (
      !decoded.id ||
      !decoded.username ||
      !ROLES.includes(decoded.role) ||
      typeof decoded.tokenVersion !== 'number'
    ) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Token revocation: reject tokens issued before the user's version was
  // bumped (e.g. after a password change).
  return asyncHandler<AuthRequest>(async (req2, res2, next2) => {
    const user = await queryOne(
      'SELECT id, token_version FROM users WHERE id = ?',
      [decoded.id]
    ) as { id: string; token_version: number } | undefined;

    if (!user || decoded.tokenVersion !== user.token_version) {
      return res2.status(401).json({ error: 'Session revoked, please log in again' });
    }

    // Slide the session forward once past the halfway point so an active admin
    // stays logged in while an abandoned browser still expires.
    const issuedAt = decoded.iat ?? 0;
    if (Math.floor(Date.now() / 1000) - issuedAt > TOKEN_TTL_SECONDS / 2) {
      setAuthCookie(res2, jwt.sign(
        {
          id: decoded.id,
          username: decoded.username,
          role: decoded.role,
          tokenVersion: decoded.tokenVersion,
        },
        secret,
        { expiresIn: TOKEN_TTL_SECONDS }
      ));
    }

    req2.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
    };

    next2();
  })(req, res, next);
}

export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }

  if (req.user.role !== 'super_admin') {
    return res.status(403).json({
      error: 'Super admin access required',
    });
  }

  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }

  if (!ROLES.includes(req.user.role)) {
    return res.status(403).json({
      error: 'Admin access required',
    });
  }

  next();
}
