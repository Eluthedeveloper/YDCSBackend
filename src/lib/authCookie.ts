import type { Request, Response } from 'express';

export const AUTH_COOKIE = 'ydcs_session';

// Sessions slide: any authenticated request past the halfway point re-issues the
// cookie, so an active admin never gets logged out mid-session while an idle
// session still expires on schedule.
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: TOKEN_TTL_SECONDS * 1000,
  };
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(AUTH_COOKIE, token, cookieOptions());
}

export function clearAuthCookie(res: Response) {
  // clearCookie matches on name/path/domain, and expires the cookie itself.
  // Passing maxAge here would be ignored by Express 5 and, in 4.x, fights the
  // expiry attribute.
  const { maxAge: _maxAge, ...matchOptions } = cookieOptions();
  res.clearCookie(AUTH_COOKIE, matchOptions);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Reads the session token from the httpOnly cookie first, falling back to an
 * `Authorization: Bearer` header for non-browser API clients. Browsers use the
 * cookie, which keeps the token out of reach of any injected script.
 */
export function readToken(req: Request): string | null {
  const cookieToken = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const value = authHeader.slice(7).trim();
    if (value) return value;
  }
  return null;
}
