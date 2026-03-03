import { NextRequest, NextResponse } from 'next/server'
import { Queue } from 'bullmq'
import { getRedisForQueue } from '@/lib/redis'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

/**
 * All BullMQ queue names used by the application.
 * Must stay in sync with src/lib/queue.ts and src/worker/index.ts.
 */
const QUEUE_NAMES = [
  'video-processing',
  'asset-processing',
  'client-file-processing',
  'project-file-processing',
  'project-email-processing',
  'album-photo-social-processing',
  'album-photo-zip-processing',
  'notification-processing',
]

/**
 * POST /api/settings/purge-bullmq-jobs
 *
 * Counts (dry-run) or removes completed / failed jobs from every BullMQ queue.
 * Completed jobs older than 1 hour and failed jobs older than 24 hours are purged.
 *
 * Body: { dryRun?: boolean }   (default true)
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 10 })
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun !== false

  try {
    const connection = getRedisForQueue()
    const queues: Record<string, { completed: number; failed: number }> = {}
    let totalCompleted = 0
    let totalFailed = 0
    let totalCleaned = 0

    for (const name of QUEUE_NAMES) {
      const queue = new Queue(name, { connection })

      try {
        const completedCount = await queue.getCompletedCount()
        const failedCount = await queue.getFailedCount()

        if (!dryRun) {
          // Remove completed jobs older than 1 hour
          const cleanedCompleted = await queue.clean(3600 * 1000, 0, 'completed')
          // Remove failed jobs older than 24 hours
          const cleanedFailed = await queue.clean(86400 * 1000, 0, 'failed')
          totalCleaned += cleanedCompleted.length + cleanedFailed.length
        }

        if (completedCount > 0 || failedCount > 0) {
          queues[name] = { completed: completedCount, failed: failedCount }
        }

        totalCompleted += completedCount
        totalFailed += failedCount
      } finally {
        await queue.close()
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      totalCompleted,
      totalFailed,
      totalKeys: totalCompleted + totalFailed,
      ...(dryRun ? {} : { totalCleaned }),
      queues,
    })
  } catch (err: any) {
    console.error('[purge-bullmq-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
