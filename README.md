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
| `NODE_ENV` | `production` marks session cookies `secure` |

The CORS allowlist in `src/index.ts` is an explicit origin list, not an
environment variable. Add a deployment origin there when you add a host, and
note that `x-client-fingerprint` must stay in `allowedHeaders` or the browser
preflight rejects the like and listen calls.

`docker compose up -d --build` builds both services and wires nginx to the API
on the same origin, which keeps the session cookie first-party.

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