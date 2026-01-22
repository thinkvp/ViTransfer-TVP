import { NextRequest, NextResponse } from 'next/server'
import { Queue } from 'bullmq'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getRedisForQueue } from '@/lib/redis'
import { reconcileAllProjectsTotalBytes } from '@/lib/project-total-bytes'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 5,
      message: 'Too many requests. Please slow down.',
    },
    'reconcile-project-total-bytes-manual'
  )
  if (rateLimitResult) return rateLimitResult

  // Prefer running via the worker queue so the request returns quickly.
  // If the queue/redis is unavailable (e.g., worker not configured), fall back to an inline run.
  const manualJobId = 'reconcile-project-total-bytes-manual'
  let queue: Queue | null = null

  try {
    queue = new Queue('notification-processing', { connection: getRedisForQueue() })

    try {
      const job = await queue.add(
        'reconcile-project-total-bytes',
        {},
        {
          jobId: manualJobId,
          removeOnComplete: true,
          removeOnFail: false,
        }
      )

      return NextResponse.json({ ok: true, queued: true, jobId: String(job.id ?? manualJobId) })
    } catch (e: any) {
      // BullMQ throws when jobId already exists.
      const msg = String(e?.message || '')
      if (msg.toLowerCase().includes('job') && msg.toLowerCase().includes('exists')) {
        return NextResponse.json({ ok: true, queued: true, alreadyQueued: true, jobId: manualJobId })
      }
      throw e
    }
  } catch (e) {
    console.warn('[SETTINGS] Failed to enqueue reconcile-project-total-bytes; running inline:', e)
    const result = await reconcileAllProjectsTotalBytes()
    return NextResponse.json({ ok: true, queued: false, ranInline: true, result })
  } finally {
    try {
      await queue?.close()
    } catch {
      // ignore
    }
  }
}
