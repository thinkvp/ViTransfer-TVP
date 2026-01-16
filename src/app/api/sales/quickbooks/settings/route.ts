import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { Queue } from 'bullmq'
import { getRedisForQueue } from '@/lib/redis'
import {
  getQuickBooksDailyPullSettings,
  parseDailyTimeToCronPattern,
  saveQuickBooksDailyPullSettings,
} from '@/lib/quickbooks/integration-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clampLookbackDays(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value)
  const days = Number.isFinite(raw) ? Math.floor(raw) : 7
  return Math.min(Math.max(days, 0), 3650)
}

function normalizeTime(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : ''
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
  return match ? s : '21:00'
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many requests. Please wait a moment.'
    },
    'sales-qbo-settings-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const settings = await getQuickBooksDailyPullSettings()
  const cron = parseDailyTimeToCronPattern(settings.dailyPullTime)

  const res = NextResponse.json({
    ...settings,
    cronPattern: cron.pattern,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: 'Too many saves. Please wait a moment.'
    },
    'sales-qbo-settings-save',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)

  const dailyPullEnabled = typeof body?.dailyPullEnabled === 'boolean' ? body.dailyPullEnabled : true
  const dailyPullTime = normalizeTime(body?.dailyPullTime)
  const pullLookbackDays = clampLookbackDays(body?.pullLookbackDays)

  const saved = await saveQuickBooksDailyPullSettings({
    dailyPullEnabled,
    dailyPullTime,
    pullLookbackDays,
  })

  const cron = parseDailyTimeToCronPattern(saved.dailyPullTime)

  let scheduleUpdated = false
  let scheduleUpdateError: string | null = null
  try {
    const queue = new Queue('notification-processing', { connection: getRedisForQueue() })

    const repeatables = await queue.getRepeatableJobs()
    const toRemove = repeatables.filter((job) => job.name === 'quickbooks-daily-pull')
    for (const job of toRemove) {
      await queue.removeRepeatableByKey(job.key)
    }

    if (saved.dailyPullEnabled) {
      await queue.add(
        'quickbooks-daily-pull',
        {},
        {
          repeat: { pattern: cron.pattern },
          jobId: 'quickbooks-daily-pull',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    }

    scheduleUpdated = true
  } catch (e) {
    scheduleUpdateError = e instanceof Error ? e.message : String(e)
  }

  const res = NextResponse.json({
    ...saved,
    cronPattern: cron.pattern,
    scheduleUpdated,
    scheduleUpdateError,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
