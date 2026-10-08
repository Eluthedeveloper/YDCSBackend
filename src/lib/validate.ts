/**
 * Request-body field coercion shared by the upload routes.
 *
 * Both `tracks.ts` and `programs.ts` take `multipart/form-data`, which shapes
 * the body in two ways that JSON does not: every field arrives as a string, and
 * a repeated field (`?title=a&title=b`) arrives as an array. Neither is usable
 * as-is — `.trim()` on an array throws a TypeError that surfaces as a 500, and
 * an array handed to mysql2 fails the bind just as opaquely.
 */

/**
 * Normalises one field to a trimmed string, or null if it is not a single
 * string. An empty or whitespace-only result is returned as `''`, leaving the
 * caller to decide whether that means "absent" or "clear this field".
 */
export function singleString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * Coerces a duration to a non-negative finite number, returning `fallback` when
 * the field is absent and null when it is present but unusable.
 *
 * `Number.isFinite` is used in place of `isNaN` because `isNaN(Infinity)` is
 * false, and `Infinity` is still rejected by MySQL's DOUBLE column. The absent
 * case is reported as `fallback` rather than 0 so an update cannot collapse a
 * real duration to zero by reading "not sent" and "sent as 0" as the same thing.
 */
export function coerceDuration(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}