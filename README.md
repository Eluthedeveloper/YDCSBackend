# EthioGospel backend

Express + MySQL API for the streaming site. Node's native test runner is not
used; the suite runs on Vitest.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with reload on save |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage |
| `npm run seed` | Create the initial admin and sample rows |

## Configuration

Copy `docker-compose.env.example` to `.env` in this directory and fill in the
placeholders. Never commit the filled-in file. One `.env` serves both
`npm run dev` and `docker compose`.

| Variable | Notes |
| --- | --- |
| `MYSQL_*` | Database, app user, and password |
| `JWT_SECRET` | 48 random bytes hex. Rotating it invalidates every session |
| `REDIS_ENABLED` | `false` runs without Redis; otherwise rate limiting and caching need it |
| `SMTP_*`, `CONTACT_*` | Contact form delivery; use a Gmail App Password |
| `UPLOAD_CHUNK_BYTES` | Bytes per audio upload chunk. Default 512 KB, which fits under nginx's stock 1 MB body cap. Raise it only when the front proxy allows larger bodies |
| `STREAM_CONTENT_TYPE` | Content-Type for the extensionless `.stream` audio URLs. `audio` (default) declares the real audio type — required, because iOS Safari will not decode a media element whose response is not typed as audio. `neutral` restores the old `application/octet-stream` answer |
| `FFMPEG_PATH` | ffmpeg binary used to package HLS. Defaults to `ffmpeg` on `PATH`; the Docker image installs it. Without it the player falls back to progressive streaming |
| `HLS_SEGMENT_SECONDS`, `HLS_AUDIO_BITRATE`, `HLS_MAX_CONCURRENCY`, `HLS_FFMPEG_TIMEOUT_MS` | Tuning for the HLS packager. Defaults: 6 s segments, 128 kbps AAC, 2 concurrent transcodes, 5 minute timeout |

New uploads are packaged in the background after the row is created; tracks
uploaded before HLS was enabled are packaged on their first play. Cached
packages live under `uploads/hls/<stem>/`. With `X_ACCEL_PREFIX` set, nginx
serves the segments (the playlist stays on Node because it must be generated
and revalidated).
| `NODE_ENV` | `production` marks session cookies `secure` |

The CORS allowlist in `src/index.ts` is an explicit origin list, not an
environment variable. Add a deployment origin there when you add a host, and
note that `x-client-fingerprint` must stay in `allowedHeaders` or the browser
preflight rejects the like and listen calls.

`docker compose up -d --build` builds both services and wires nginx to the API
on the same origin, which keeps the session cookie first-party.

## Visitor chatbot

The floating assistant on the public site uses the local database, not an
external model. There is no API key, no paid service and no prompt to maintain
in source code.

- `POST /api/chatbot/message` accepts `{ sessionId, message, lang }` and returns
  the answer plus match metadata. Conversations and every message are stored in
  `chatbot_conversations` / `chatbot_messages` for admin review.
- Answers come from `chatbot_knowledge`, seeded with 11 intents and English,
  Amharic and Afaan Oromo entries by migration `022_seed_chatbot_defaults`.
  Admins edit these in `/admin/player/chatbot`; no React file contains answers.
- Matching combines exact/phrase overlap, keyword overlap and Fuse.js fuzzy
  search, with a small boost for the current intent during follow-ups. The
  confidence threshold, fuzzy threshold, languages, welcome/fallback messages,
  sync interval and approval mode are all editable in the admin UI and cached
  in Redis when available.
- `GET /api/chatbot/suggestions?lang=en` serves the highest-priority approved
  questions so the widget never hardcodes suggestions.
- Published announcements, events, blog articles, programmes, tracks, albums,
  leaders and radio-schedule rows are synced into `chatbot_knowledge` by
  `src/lib/chatbotSync.ts`. A successful content write schedules a debounced
  refresh; a 10-minute scheduler is the backup; `POST /api/admin/chatbot/sync/run`
  triggers it manually. Synced entries carry `source_table`, `source_id` and a
  content hash so edits update in place and deletions remove stale answers.
- By default synced content is approved automatically. Turn off
  `auto_approve_content` in the admin settings to require review; pending
  entries are hidden from visitors until approved.
- All chatbot caches are invalidated when knowledge, settings or synced content
  changes. The public message route caps input at 1500 characters and applies
  `chatLimiter` (40 messages per 15 minutes per IP). Responses are
  `no-store` because each conversation is specific to one visitor.

## Schema

`src/database/migrations.ts` owns the schema. Migrations run in order inside a
transaction at boot, tracked in the `schema_migrations` table; there is no DDL
in application code. Adding a migration means appending to the ordered list and
redeploying.

## Deployment notes

- Serve the frontend over HTTPS in production. `NODE_ENV=production` marks the
  session cookie `secure`, and a browser will drop a `secure` cookie sent over
  plain HTTP, so a plain-HTTP production host means no login at all.
- nginx proxies `/api/` to the backend with buffering disabled so HTTP Range
  requests reach the browser intact and audio seeking keeps working.
- **The proxy in front of the API must allow request bodies larger than one
  upload chunk.** nginx ships with `client_max_body_size 1m`, and a proxy left
  at that default rejects every chunk itself with its own HTML `413` — the
  request never reaches Express, so the API logs nothing and the upload UI
  only reports "Chunk 0 failed (HTTP 413)". The in-container nginx
  (`frontend/nginx.conf`) sets `client_max_body_size 200m`, but the host-level
  proxy that terminates TLS in front of the container needs the same setting.
  Audio uploads work without touching that proxy because the chunk size
  defaults to 512 KB, which fits under the 1 MB default.
- Existing credentials that were ever committed should be rotated: change the
  database passwords, `JWT_SECRET`, and the SMTP app password.

## Authentication

Login sets an httpOnly `ydcs_session` cookie (`SameSite=Lax`, `secure` under
`production`, 8-hour sliding expiry). Reads check the cookie first and fall back
to `Authorization: Bearer` for API clients.

- Passwords are bcrypt hashed at cost 12 and must be at least 8 characters.
- Password changes bump the user's token version, which invalidates their other
  sessions.
- Sessions carry a token version that logout increments, so a stolen cookie
  cannot outlive a logout.
- `admin` and `super_admin` are enforced server-side, not just hidden in the UI.
- Deleting a user with owned content returns `409` rather than silently
  reassigning it.

## Uploads

Multer writes to disk with traversal-safe filenames. Failed database writes
remove the file they created, and deleting a program removes orphaned audio.
Request bodies are trusted as-is and escaped at render time; there is no HTML
sanitizer because React handles output encoding.

## Tests

`npx vitest run` covers cookie and CORS behaviour, auth and rate limiting,
migrations, uploads, ownership checks, and cache invalidation.