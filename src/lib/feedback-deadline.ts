/**
 * Per-version client feedback deadlines.
 *
 * A deadline is a date only (YYYY-MM-DD) meaning "end of that day". It is purely
 * informational: once it passes the share page shows "Overdue" and nothing is locked.
 *
 * A deadline only matters while it is ACTIVE — the client still owes feedback on that
 * exact version. The share page, the "ready" emails, the scheduled reminder job and the
 * manual reminder all use isFeedbackDeadlineActive(), so keep every caller on it rather
 * than re-deriving the rule (the same trap as the Reviewed / View Only predicates).
 *
 * Safe to import from client components (no server-only imports).
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseFeedbackDueDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const m = YMD_RE.exec(value.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(y, mo - 1, d)
  // Reject rollovers like 2026-02-31.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

export function isValidFeedbackDueDate(value: unknown): value is string {
  return parseFeedbackDueDate(value) !== null
}

/** Today's date as YYYY-MM-DD in the process's local timezone (server TZ / browser TZ). */
export function todayYmd(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDaysYmd(ymd: string, days: number): string | null {
  const dt = parseFeedbackDueDate(ymd)
  if (!dt) return null
  dt.setDate(dt.getDate() + Math.trunc(days))
  return todayYmd(dt)
}

/** Whole calendar days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier). */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const a = parseFeedbackDueDate(fromYmd)
  const b = parseFeedbackDueDate(toYmd)
  if (!a || !b) return null
  // Noon-anchored UTC to stay clear of DST shifts.
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate(), 12)
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate(), 12)
  return Math.round((ub - ua) / 86_400_000)
}

export type FeedbackDeadlineStatus = 'upcoming' | 'today' | 'overdue'

export function getFeedbackDeadlineStatus(dueYmd: string, today: string = todayYmd()): {
  status: FeedbackDeadlineStatus
  daysLeft: number
} | null {
  const daysLeft = daysBetweenYmd(today, dueYmd)
  if (daysLeft === null) return null
  return { status: daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : 'upcoming', daysLeft }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function isMonthFirstTimezone(): boolean {
  const tz = typeof window !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone)
  return Boolean(tz && (tz.startsWith('America/') || tz.startsWith('US/')))
}

/**
 * "Fri 21 Nov" (day-first regions) / "Fri, Nov 21" (Americas). The year is appended
 * when it differs from the current year, or always with `withYear`.
 */
export function formatFeedbackDueDate(ymd: string, opts: { withYear?: boolean; now?: Date } = {}): string {
  const dt = parseFeedbackDueDate(ymd)
  if (!dt) return ymd
  const now = opts.now ?? new Date()
  const showYear = opts.withYear || dt.getFullYear() !== now.getFullYear()
  const wd = WEEKDAYS[dt.getDay()]
  const mon = MONTHS[dt.getMonth()]
  const day = dt.getDate()
  if (isMonthFirstTimezone()) {
    return `${wd}, ${mon} ${day}${showYear ? `, ${dt.getFullYear()}` : ''}`
  }
  return `${wd} ${day} ${mon}${showYear ? ` ${dt.getFullYear()}` : ''}`
}

/** Short relative phrase for UI pills: "Due today", "Due tomorrow", "Due in 3 days", "Overdue". */
export function describeFeedbackDeadline(dueYmd: string, today: string = todayYmd()): string {
  const s = getFeedbackDeadlineStatus(dueYmd, today)
  if (!s) return ''
  if (s.status === 'overdue') return s.daysLeft === -1 ? 'Overdue by 1 day' : `Overdue by ${-s.daysLeft} days`
  if (s.status === 'today') return 'Due today'
  if (s.daysLeft === 1) return 'Due tomorrow'
  return `Due in ${s.daysLeft} days`
}

export type FeedbackDeadlineVideo = {
  id: string
  version: number
  approved?: boolean | null
  revisionRequestedAt?: Date | string | null
  feedbackDueDate?: string | null
  status?: string | null
}

const INACTIVE_PROJECT_STATUSES = new Set(['APPROVED', 'CLOSED', 'ON_HOLD'])

/**
 * Is `video`'s feedback deadline still live? True only when the client still owes
 * feedback on this exact version:
 *  - it has a valid due date and is READY (when status is provided)
 *  - it is the latest version in its name group (`groupVersions` = every version of
 *    that video name, including `video` itself)
 *  - no version in the group is approved, and the client hasn't requested the next version
 *  - the project isn't approved, closed or on hold
 */
export function isFeedbackDeadlineActive(
  video: FeedbackDeadlineVideo,
  groupVersions: FeedbackDeadlineVideo[],
  projectStatus: string | null | undefined
): boolean {
  if (!isValidFeedbackDueDate(video.feedbackDueDate)) return false
  if (video.status != null && video.status !== 'READY') return false
  if (projectStatus && INACTIVE_PROJECT_STATUSES.has(projectStatus)) return false
  if (video.approved) return false
  if (video.revisionRequestedAt) return false
  const readyGroup = groupVersions.filter((v) => v.status == null || v.status === 'READY')
  if (readyGroup.some((v) => v.approved)) return false
  const latestVersion = Math.max(video.version, ...readyGroup.map((v) => v.version))
  return video.version === latestVersion
}

/**
 * Normalise the admin "days before" setting: unique integers 0–30, sorted descending
 * (furthest-out reminder first). Falls back to [1].
 */
export function normalizeReminderDaysBefore(value: unknown): number[] {
  const arr = Array.isArray(value) ? value : []
  const out = Array.from(
    new Set(
      arr
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 30)
    )
  ).sort((a, b) => b - a)
  return out
}

/**
 * Which scheduled reminder (if any) should go out today for a deadline?
 * Returns the trigger date (YYYY-MM-DD) of the most recent reminder slot that has
 * arrived, or null when none is due. A slot is due when its trigger date is today or
 * earlier, the deadline hasn't passed, and no reminder was sent on/after that trigger
 * date. Because slots are derived from the due date, extending a deadline naturally
 * re-arms the reminders without resetting any state.
 *
 * Slots whose trigger date is before `notBeforeYmd` are ignored — pass the day after
 * the version was uploaded so a short deadline doesn't fire a reminder on the same day
 * the client was told the version is ready.
 */
export function dueReminderTrigger(params: {
  dueYmd: string
  daysBefore: number[]
  today: string
  lastReminderYmd: string | null
  notBeforeYmd?: string | null
}): string | null {
  const { dueYmd, daysBefore, today, lastReminderYmd, notBeforeYmd } = params
  const untilDue = daysBetweenYmd(today, dueYmd)
  if (untilDue === null || untilDue < 0) return null
  let latestTrigger: string | null = null
  for (const n of daysBefore) {
    const trigger = addDaysYmd(dueYmd, -n)
    if (!trigger) continue
    if (trigger > today) continue
    if (notBeforeYmd && trigger < notBeforeYmd) continue
    if (!latestTrigger || trigger > latestTrigger) latestTrigger = trigger
  }
  if (!latestTrigger) return null
  if (lastReminderYmd && lastReminderYmd >= latestTrigger) return null
  return latestTrigger
}
