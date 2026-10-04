import { describe, it, expect, vi } from 'vitest';
import { AUTH_COOKIE, readToken, setAuthCookie, clearAuthCookie, TOKEN_TTL_SECONDS } from './authCookie';
import type { Request, Response } from 'express';

function fakeRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };
}

function reqWith(headers: Record<string, string>): Request {
  return { headers, get: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

describe('setAuthCookie', () => {
  it('marks the cookie httpOnly so injected script cannot read the token', () => {
    const res = fakeRes();
    setAuthCookie(res, 'jwt-value');

    const [name, value, options] = res.cookie.mock.calls[0]!;
    expect(name).toBe(AUTH_COOKIE);
    expect(value).toBe('jwt-value');
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: TOKEN_TTL_SECONDS * 1000,
    });
  });
});

describe('clearAuthCookie', () => {
  it('uses the same attributes so the browser actually drops the cookie', () => {
    const res = fakeRes();
    clearAuthCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(
      AUTH_COOKIE,
      expect.objectContaining({ httpOnly: true, path: '/' })
    );
  });
});

describe('readToken', () => {
  it('prefers the cookie over an Authorization header', () => {
    const req = reqWith({
      cookie: `other=1; ${AUTH_COOKIE}=from-cookie`,
      authorization: 'Bearer from-header',
    });
    expect(readToken(req)).toBe('from-cookie');
  });

  it('falls back to a Bearer header for non-browser clients', () => {
    expect(readToken(reqWith({ authorization: 'Bearer from-header' }))).toBe('from-header');
  });

  it('decodes percent-encoded cookie values', () => {
    expect(readToken(reqWith({ cookie: `${AUTH_COOKIE}=a%2Bb` }))).toBe('a+b');
  });

  it('returns null when neither is present', () => {
    expect(readToken(reqWith({}))).toBeNull();
  });

  it('ignores an empty Bearer value rather than returning ""', () => {
    expect(readToken(reqWith({ authorization: 'Bearer ' }))).toBeNull();
  });

  it('ignores a cookie header with no value', () => {
    expect(readToken(reqWith({ cookie: AUTH_COOKIE }))).toBeNull();
  });

  it('does not throw on a malformed percent-encoding', () => {
    expect(() => readToken(reqWith({ cookie: `${AUTH_COOKIE}=%E0%A4%A` }))).not.toThrow();
  });
});
