import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { prisma } from '@/lib/db'
import { isS3Mode } from '@/lib/s3-storage'
import {
  getS3LocalBackupSettings,
  ALL_BACKUP_CATEGORIES,
  type BackupCategory,
} from '@/lib/s3-local-backup'
import { enqueueS3LocalBackup } from '@/lib/queue'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests.' },
    's3-local-backup-status',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 mode is not active' }, { status: 400 })
  }

  const settings = await getS3LocalBackupSettings()
  if (!settings) {
    return NextResponse.json({ error: 'Could not load backup settings' }, { status: 500 })
  }

  return NextResponse.json(settings)
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 5, message: 'Too many backup requests. Please slow down.' },
    's3-local-backup-run',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 mode is not active' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun === true

  // Validate categories list
  let categories: BackupCategory[]
  if (Array.isArray(body.categories) && body.categories.length > 0) {
    categories = body.categories.filter((c: unknown): c is BackupCategory =>
      typeof c === 'string' && ALL_BACKUP_CATEGORIES.includes(c as BackupCategory),
    )
    if (categories.length === 0) {
      return NextResponse.json({ error: 'No valid categories supplied' }, { status: 400 })
    }
  } else {
    // Fall back to settings-configured categories
    const settings = await getS3LocalBackupSettings()
    if (!settings) {
      return NextResponse.json({ error: 'Could not load backup settings' }, { status: 500 })
    }
    categories = settings.categories
    if (categories.length === 0) {
      return NextResponse.json({ error: 'No backup categories are configured' }, { status: 400 })
    }
  }

  // Optimistic lock — prevent concurrent runs. getS3LocalBackupSettings() applies the
  // stale-lock self-heal, so a flag orphaned by a hung/killed run won't block a new run.
  const currentSettings = await getS3LocalBackupSettings()
  if (currentSettings?.running) {
    return NextResponse.json({ error: 'A backup run is already in progress' }, { status: 409 })
  }

  // Run on the WORKER, never in this web process. The backup mirrors S3 to local disk,
  // and that disk is the worker's (bulk storage) — running it here would fill the app
  // host's disk, which is exactly what caused the 2026-07-08 outage. Both the real run
  // and the dry-run are enqueued so the worker owns execution and the on-disk comparison
  // reflects the mirror's actual location. Enqueue FIRST, then take the lock, so a Redis
  // failure can't leave a stuck "running" flag behind.
  try {
    await enqueueS3LocalBackup(categories, { dryRun })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Could not queue the backup — is the job queue reachable?' },
      { status: 500 },
    )
  }

  const queuedMessage = dryRun
    ? 'Queued dry run — waiting for the backup worker…'
    : 'Queued — waiting for the backup worker…'

  await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      s3LocalBackupRunning: true,
      s3LocalBackupStartedAt: new Date(),
      s3LocalBackupLastRunResult: queuedMessage,
    },
    create: {
      id: 'default',
      s3LocalBackupRunning: true,
      s3LocalBackupStartedAt: new Date(),
      s3LocalBackupLastRunResult: queuedMessage,
    },
  })

  return NextResponse.json({ ok: true, queued: true, dryRun })
}
