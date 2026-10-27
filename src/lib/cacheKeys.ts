/**
 * Cache keys derived from a write, so invalidation names them instead of
 * scanning for them.
 *
 * Every public read is cached under a known, finite set of keys — search results
 * are deliberately excluded (see the comment in routes/public.ts) precisely so
 * this set stays exhaustive. Writes used to call `cacheInvalidate('public:*')`,
 * which walks the entire Redis keyspace on the request path: with one key per
 * program, every admin upload paid a SCAN proportional to the size of the
 * catalogue.
 *
 * `admin:analytics` is included because listens cascade away with a deleted
 * track, so the play counts it embeds change too.
 */
export function programReadCacheKeys(programId?: string): string[] {
  return [
    'public:programs',
    'public:latest-tracks',
    'public:listens:stats',
    'admin:analytics',
    ...(programId ? [`public:program:${programId}`] : []),
  ];
}

/**
 * Keys for the site-content reads (leaders, albums, announcements, events,
 * blog). Called with no argument it returns the whole set — useful when a
 * write's blast radius is unclear — and with a resource name it returns just
 * that resource's key, which is what every route write does so one edit never
 * flushes the other caches.
 */
export function siteReadCacheKeys(
  resource?: 'leaders' | 'albums' | 'announcements' | 'events' | 'blog' | 'whats-new' | 'schedule'
): string[] {
  const keys = {
    leaders: 'public:site:leaders',
    albums: 'public:site:albums',
    announcements: 'public:site:announcements',
    events: 'public:site:events',
    blog: 'public:site:blog',
    'whats-new': 'public:site:whats-new',
    schedule: 'public:site:schedule',
  } as const;
  return resource ? [keys[resource]] : Object.values(keys);
}

/**
 * Keys a write to the feed-shaped resources (announcements, events, blog)
 * has to drop: its own list plus the merged "what's new" feed the
 * notification bell polls. Forgetting the second one is how a new post ends
 * up invisible to the bell for five minutes while the page already shows it.
 */
export function feedReadCacheKeys(resource: 'announcements' | 'events' | 'blog'): string[] {
  return [...siteReadCacheKeys(resource), ...siteReadCacheKeys('whats-new')];
}
