import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { queryOne } from '../database/schema';

export interface AuthUser {
  id: string;
  username: string;
  role: 'super_admin' | 'admin';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

interface TokenPayload extends JwtPayload {
  id: string;
  username: string;
  role: 'super_admin' | 'admin';
  tokenVersion: number;
}

export function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

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
      !['admin', 'super_admin'].includes(decoded.role)
    ) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Token revocation: reject tokens issued before the user's version was
  // bumped (e.g. after a password change).
  (async () => {
    try {
      const user = await queryOne(
        'SELECT id, token_version FROM users WHERE id = ?',
        [decoded.id]
      ) as { id: string; token_version: number } | undefined;

      if (!user || decoded.tokenVersion !== user.token_version) {
        return res.status(401).json({ error: 'Session revoked, please log in again' });
      }

      req.user = {
        id: decoded.id,
        username: decoded.username,
        role: decoded.role,
      };

      next();
    } catch (err) {
      console.error('Token verification error:', err);
      res.status(500).json({ error: 'Authentication failed' });
    }
  })();
}


export function requireSuperAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
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


export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }

  if (!['super_admin', 'admin'].includes(req.user.role)) {
    return res.status(403).json({
      error: 'Admin access required',
    });
  }

  next();
}