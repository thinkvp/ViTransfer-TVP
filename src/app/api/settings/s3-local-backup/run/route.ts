import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { prisma } from '@/lib/db'
import { isS3Mode } from '@/lib/s3-storage'
import {
  runS3LocalBackup,
  getS3LocalBackupSettings,
  formatBackupResultSummary,
  ALL_BACKUP_CATEGORIES,
  type BackupCategory,
  type BackupProgressFn,
} from '@/lib/s3-local-backup'
import { upsertS3BackupFailureNotification } from '@/lib/s3-backup-failure-notifications'

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes max â€” backups can be large

// Human-readable label for a category key, e.g. "videoPreviewsBytes" â†’ "Video Previews"
function categoryLabel(cat: BackupCategory): string {
  return cat
    .replace(/Bytes$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

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

  // Dry run — scan and report without downloading or updating DB
  if (dryRun) {
    try {
      const result = await runS3LocalBackup(categories, undefined, { dryRun: true })
      const summary = formatBackupResultSummary(result)
      return NextResponse.json({ ok: true, result, summary })
    } catch (err: any) {
      return NextResponse.json({ error: err?.message || 'Dry run failed' }, { status: 500 })
    }
  }

  // Optimistic lock â€” prevent concurrent runs. getS3LocalBackupSettings() applies the
  // stale-lock self-heal, so a flag orphaned by a hung/killed run won't block a new run.
  const currentSettings = await getS3LocalBackupSettings()
  if (currentSettings?.running) {
    return NextResponse.json({ error: 'A backup run is already in progress' }, { status: 409 })
  }

  await prisma.settings.upsert({
    where: { id: 'default' },
    update: { s3LocalBackupRunning: true, s3LocalBackupStartedAt: new Date() },
    create: { id: 'default', s3LocalBackupRunning: true, s3LocalBackupStartedAt: new Date() },
  })

  // Progress callback â€” writes live status to DB so the UI can poll it.
  const onProgress: BackupProgressFn = async (info) => {
    const label = categoryLabel(info.currentCategory)
    const fileProgress = info.filesInCategory > 0
      ? ` \u2014 ${info.filesProcessed}/${info.filesInCategory} files`
      : ''
    const text = info.filesProcessed === 0
      ? `Starting ${label} (category ${info.categoryIndex + 1}/${info.totalCategories})...`
      : `${label} (${info.categoryIndex + 1}/${info.totalCategories})${fileProgress} \u2014 ${info.downloaded} downloaded, ${info.skipped} already up-to-date`
    await prisma.settings.update({
      where: { id: 'default' },
      data: { s3LocalBackupLastRunResult: text },
    }).catch(() => {})
  }

  try {
    const result = await runS3LocalBackup(categories, onProgress)
    const summary = formatBackupResultSummary(result)

    await prisma.settings.update({
      where: { id: 'default' },
      data: {
        s3LocalBackupLastRunAt: new Date(),
        s3LocalBackupLastRunResult: summary,
        s3LocalBackupRunning: false,
        s3LocalBackupStartedAt: null,
      },
    })

    // If the backup completed with failures, fire a pinned system notification
    if (!result.ok && result.failed > 0) {
      const errorSummary = result.errors.slice(0, 3).join('; ') || 'Unknown error'
      upsertS3BackupFailureNotification(`${result.failed} file(s) failed. ${errorSummary}`).catch(() => {})
    }

    return NextResponse.json({ ok: true, result, summary })
  } catch (err: any) {
    const message = err?.message || 'Backup failed unexpectedly'
    await prisma.settings.update({
      where: { id: 'default' },
      data: {
        s3LocalBackupLastRunResult: `Error: ${message}`,
        s3LocalBackupRunning: false,
        s3LocalBackupStartedAt: null,
      },
    }).catch(() => {})
    upsertS3BackupFailureNotification(message).catch(() => {})
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
