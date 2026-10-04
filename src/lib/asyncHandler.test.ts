import { describe, it, expect, vi } from 'vitest';
import { asyncHandler } from './asyncHandler';
import type { Request, Response, NextFunction } from 'express';

function fakeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('asyncHandler', () => {
  it('forwards a rejection to next() instead of dropping it', async () => {
    // This is the bug it exists for: an async route handler that throws used
    // to produce an unhandled rejection, leaving the request hanging with no
    // response instead of a 500.
    const boom = new Error('db exploded');
    const next = vi.fn();
    const handler = asyncHandler(async () => {
      throw boom;
    });

    handler({} as Request, fakeRes(), next as NextFunction);

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(boom));
  });

  it('forwards a synchronous throw from an async fn', async () => {
    const next = vi.fn();
    const handler = asyncHandler(async () => {
      throw new Error('nope');
    });

    handler({} as Request, fakeRes(), next as NextFunction);

    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
  });

  it('does not call next() when the handler resolves', async () => {
    const next = vi.fn();
    const handler = asyncHandler(async () => undefined);

    handler({} as Request, fakeRes(), next as NextFunction);

    await new Promise((r) => setTimeout(r, 10));
    expect(next).not.toHaveBeenCalled();
  });
});
