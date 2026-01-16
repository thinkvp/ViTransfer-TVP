import { prisma } from '@/lib/db'

const INTEGRATION_ID = 'default'

export type QuickBooksDailyPullSettings = {
  dailyPullEnabled: boolean
  dailyPullTime: string // HH:MM
  pullLookbackDays: number
  lastDailyPullAttemptAt: Date | null
  lastDailyPullSucceeded: boolean | null
  lastDailyPullMessage: string | null
}

const DEFAULTS: QuickBooksDailyPullSettings = {
  dailyPullEnabled: true,
  dailyPullTime: '21:00',
  pullLookbackDays: 7,
  lastDailyPullAttemptAt: null,
  lastDailyPullSucceeded: null,
  lastDailyPullMessage: null,
}

export async function getQuickBooksDailyPullSettings(): Promise<QuickBooksDailyPullSettings> {
  try {
    const row = await (prisma as any).quickBooksIntegration.findUnique({
      where: { id: INTEGRATION_ID },
      select: {
        dailyPullEnabled: true,
        dailyPullTime: true,
        pullLookbackDays: true,
        lastDailyPullAttemptAt: true,
        lastDailyPullSucceeded: true,
        lastDailyPullMessage: true,
      },
    })

    if (!row) return { ...DEFAULTS }

    return {
      dailyPullEnabled: row.dailyPullEnabled ?? DEFAULTS.dailyPullEnabled,
      dailyPullTime: typeof row.dailyPullTime === 'string' && row.dailyPullTime.trim() ? row.dailyPullTime.trim() : DEFAULTS.dailyPullTime,
      pullLookbackDays: typeof row.pullLookbackDays === 'number' && Number.isFinite(row.pullLookbackDays) ? row.pullLookbackDays : DEFAULTS.pullLookbackDays,
      lastDailyPullAttemptAt: row.lastDailyPullAttemptAt ?? null,
      lastDailyPullSucceeded: typeof row.lastDailyPullSucceeded === 'boolean' ? row.lastDailyPullSucceeded : null,
      lastDailyPullMessage: typeof row.lastDailyPullMessage === 'string' && row.lastDailyPullMessage.trim() ? row.lastDailyPullMessage.trim() : null,
    }
  } catch {
    // If migration hasn't been applied yet, or DB is unavailable, fall back to defaults.
    return { ...DEFAULTS }
  }
}

export async function saveQuickBooksDailyPullSettings(patch: Partial<Pick<QuickBooksDailyPullSettings, 'dailyPullEnabled' | 'dailyPullTime' | 'pullLookbackDays'>>): Promise<QuickBooksDailyPullSettings> {
  const nextEnabled = typeof patch.dailyPullEnabled === 'boolean' ? patch.dailyPullEnabled : undefined
  const nextTime = typeof patch.dailyPullTime === 'string' ? patch.dailyPullTime.trim() : undefined
  const nextLookback = typeof patch.pullLookbackDays === 'number' ? patch.pullLookbackDays : undefined

  const update: any = {}
  if (typeof nextEnabled === 'boolean') update.dailyPullEnabled = nextEnabled
  if (typeof nextTime === 'string' && nextTime) update.dailyPullTime = nextTime
  if (typeof nextLookback === 'number' && Number.isFinite(nextLookback)) update.pullLookbackDays = nextLookback

  try {
    await (prisma as any).quickBooksIntegration.upsert({
      where: { id: INTEGRATION_ID },
      create: {
        id: INTEGRATION_ID,
        ...(typeof update.dailyPullEnabled === 'boolean' ? { dailyPullEnabled: update.dailyPullEnabled } : {}),
        ...(typeof update.dailyPullTime === 'string' ? { dailyPullTime: update.dailyPullTime } : {}),
        ...(typeof update.pullLookbackDays === 'number' ? { pullLookbackDays: update.pullLookbackDays } : {}),
      },
      update,
      select: { id: true },
    })
  } catch {
    // ignore
  }

  return getQuickBooksDailyPullSettings()
}

export async function recordQuickBooksDailyPullAttempt(result: {
  attemptedAt: Date
  succeeded: boolean
  message: string | null
}): Promise<void> {
  try {
    await (prisma as any).quickBooksIntegration.upsert({
      where: { id: INTEGRATION_ID },
      create: {
        id: INTEGRATION_ID,
        lastDailyPullAttemptAt: result.attemptedAt,
        lastDailyPullSucceeded: result.succeeded,
        lastDailyPullMessage: result.message,
      },
      update: {
        lastDailyPullAttemptAt: result.attemptedAt,
        lastDailyPullSucceeded: result.succeeded,
        lastDailyPullMessage: result.message,
      },
      select: { id: true },
    })
  } catch {
    // Non-fatal
  }
}

export function parseDailyTimeToCronPattern(time: string): { pattern: string; hour: number; minute: number } {
  const trimmed = (time || '').trim()
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed)
  if (!match) return { pattern: '0 21 * * *', hour: 21, minute: 0 }

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { pattern: '0 21 * * *', hour: 21, minute: 0 }

  return { pattern: `${minute} ${hour} * * *`, hour, minute }
}
