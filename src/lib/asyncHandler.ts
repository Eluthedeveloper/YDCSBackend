import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler. Express 4 does not do this on its own: an unhandled rejection
 * inside an async handler leaves the request hanging until the socket times
 * out instead of returning 500.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
