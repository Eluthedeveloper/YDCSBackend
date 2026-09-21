import { Request, Response, NextFunction } from 'express';

export function sanitize(obj: any): any {
  if (typeof obj === 'string') {
    return obj
      .replace(/<[^>]*>/g, '')
      .replace(/[<>"'&]/g, (c: string) => {
        const map: Record<string, string> = {
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#x27;',
          '&': '&amp;',
        };
        return map[c] || c;
      });
  }

  if (obj && typeof obj === 'object') {
    // Passwords must never be HTML-escaped, otherwise credentials containing
    // chars like & < " get silently corrupted before hashing.
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    const clean: any = {};
    for (const key of Object.keys(obj)) {
      clean[key] = key.toLowerCase() === 'password' ? obj[key] : sanitize(obj[key]);
    }
    return clean;
  }

  return obj;
}

// Run before body parsing (JSON) or right after multer (multipart),
// whenever req.body is already populated.
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === 'string') {
        (req.query as any)[key] = sanitize(req.query[key]);
      }
    }
  }
  next();
}