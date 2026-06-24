# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ViTransfer-TVP is a self-hosted **video production review platform + CRM**: clients receive branded share links, leave timestamped/versioned feedback, and approve videos; admins manage projects, clients, invoicing (Stripe), and accounting. Forked from MansiVisuals/ViTransfer and diverged significantly. Self-hosted via Docker Compose.

## Commands

```bash
npm run dev                  # Next.js dev server (http://localhost:4321 in prod, default next port in dev)
npm run worker               # Start the background worker (BullMQ processors) — runs via tsx, separate process from the web app
npm run build                # Production build — uses webpack (next build --webpack), output: standalone
npm run start:standalone     # Run the standalone production server (.next/standalone/server.js)

npm run lint                 # eslint .
npm run check:rbac           # Static RBAC gate check — REQUIRED to pass (see RBAC below)
npm run test:share-uploads   # API + UI smoke checks for the share-upload feature (tsx scripts)
npm run preview:emails       # Render email templates to HTML previews for inspection
```

There is **no `prisma migrate` in `npm` scripts** — run Prisma directly: `npx prisma migrate dev` (local schema change), `npx prisma migrate deploy` (apply existing), `npx prisma studio`. In Docker, `migrate deploy` runs automatically from `docker-entrypoint.sh` for the **app** container only (not the worker).

`prebuild` runs `prisma generate`, `scripts/ensure-prisma-client.mjs`, and `scripts/clean-next.mjs`. `postinstall` runs `patch-package` (see `patches/`) + `prisma generate`.

### Local dev requires running Postgres + Redis

The app and worker both need PostgreSQL and Redis. Simplest path is `docker compose up -d postgres redis` and pointing `DATABASE_URL`/`REDIS_*` at them, then running `npm run dev` + `npm run worker` on the host. `.env.example` documents all required secrets (`ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SHARE_TOKEN_SECRET`, etc.).

## Architecture

### Two processes, one codebase

1. **Web app** (`next`) — Next.js 16 App Router, React 19, serving `src/app/`. Entry-time initialization happens in `src/instrumentation.ts` (`register()`), which seeds the default admin and security settings on server start.
2. **Worker** (`src/worker/index.ts`, launched via `worker.mjs` / `npm run worker`) — a long-running BullMQ consumer that does all heavy/async work: FFmpeg transcoding, thumbnail/sprite generation, ZIP building, email/push notifications, S3 backups, scheduled reminders, and storage reconciliation. It also runs repeating maintenance jobs on timers.

The app **enqueues** jobs; the worker **processes** them. They communicate only through Postgres + Redis, never in-process.

### Job queues (`src/lib/queue.ts` + `src/worker/`)

Queues are defined and lazily instantiated in `src/lib/queue.ts` (each `*ProcessingJob` interface is the payload contract). Every queue has a matching processor file in `src/worker/` (e.g. `VideoProcessingJob` → `video-processor.ts`, `AlbumPhotoZipJob` → `album-photo-zip-processor.ts`). When adding a queue: define the payload interface + queue getter in `queue.ts`, write the processor in `src/worker/`, and register the `Worker` in `src/worker/index.ts`. CPU/concurrency for video work is centrally allocated by `src/lib/cpu-config.ts` (FFmpeg threads vs. concurrent jobs), tunable via `CPU_THREADS` / `VIDEO_WORKER_CONCURRENCY` / `FFMPEG_THREADS_PER_JOB` env vars.

### Storage abstraction (local ⇄ S3)

`src/lib/storage.ts` is the file I/O layer. It transparently switches between local disk (`STORAGE_ROOT`) and S3-compatible storage (`STORAGE_PROVIDER=s3`, e.g. Cloudflare R2) via `src/lib/s3-storage.ts`. **All storage paths are relative POSIX paths** (`projects/{id}/videos/{id}/...`); `storage.ts` aggressively validates against path traversal — never construct absolute paths or bypass it. Accounting files use a separate root (`ACCOUNTING_STORAGE_ROOT`).

### StoredFile registry — single source of truth for files

`src/lib/stored-file.ts` + the `StoredFile` Prisma model. Rather than scattering `*Path` columns across entity tables, **every file** (uploads, transcoded previews, thumbnails, ZIPs, branding assets) gets one `StoredFile` row keyed by `(entityType, entityId, fileRole)`. Use `registerStoredFile()` / `deleteStoredFile()` / the query helpers rather than writing path columns directly. This is the subject of recent active migration work (see `scripts/backfill-stored-files.ts`, `backfill-orphans-to-stored-files.ts`); legacy path columns still exist and are backfilled at runtime.

### Auth & RBAC

- **`src/lib/auth.ts`** — three token kinds: `admin_access` / `admin_refresh` (JWT with refresh rotation + revocation) for admin/staff users, and `share` tokens for client share-page sessions. WebAuthn passkeys supported (`src/lib/passkey.ts`).
- **`src/lib/rbac.ts`** — defines `MenuKey` and `ActionKey` permission sets and the `RolePermissions` shape. Roles (Prisma `Role` model) hold menu visibility, project-status visibility, and per-action booleans.
- **`src/lib/rbac-api.ts`** — server-side gate helpers: `requireApiUser`, `requireApiAdmin`, `requireApiMenu`, `requireApiAction`, `requireApiAnyAction`, `requireApiSystemAdmin`. Denials log a `PERMISSION_DENIED` security event.
- **Every API route under `src/app/api/admin/` MUST call an auth gate AND an RBAC gate.** `npm run check:rbac` (`scripts/check-rbac-gates.mjs`) statically enforces this and fails the build/CI if a route is missing a gate. Add intentional exceptions to its `ALLOWLIST`, not by removing the check.

Note: `src/proxy.ts` is the Next.js middleware (matcher `/admin/:path*`) but is currently a passthrough — auth is enforced in route handlers, not middleware.

### Data model

Single large Prisma schema (`prisma/schema.prisma`, ~90 models). Major clusters: **projects/videos/comments** (review core), **clients/recipients**, **sales** (`Sales*` quotes/invoices/payments + Stripe), **accounting** (`Account`, `JournalEntry`, vehicle logbook), **kanban**, **security** (events, blocklists, rate limits), **notifications** (queue + read state + web push), and **StoredFile**. Sales and accounting logic lives in `src/lib/sales/` and `src/lib/accounting/`. (A former pull-only QuickBooks integration was removed in 2.0.3; inert `qboId` columns and the `SalesPaymentSource.QUICKBOOKS` enum value are retained as historical identifiers only.)

### Frontend

`src/app/admin/` (admin SPA-like area, PWA-installable, admin-scoped web push), `src/app/share/` + `src/app/gv/` (client share pages and guest-video links), `src/app/sales/` (public sales document shares). UI primitives in `src/components/` use Radix UI + Tailwind + `class-variance-authority`. Recharts for analytics.

## Conventions

- **Path alias `@/`** maps to `src/`.
- This is a security-sensitive app (self-hosted, handles client media + invoicing). Preserve existing input validation, sanitization (`src/lib/security/`, `comment-sanitization.ts`, magic-byte file validation in `file-validation.ts`/`asset-validation.ts`), and rate limiting patterns when touching upload/comment/auth paths.
- `CHANGELOG.md` is actively maintained and large — add entries for user-facing changes; `VERSION` + `package.json` version are kept in sync.
- Dependency `overrides` in `package.json` pin transitive versions for security — don't loosen them casually.
