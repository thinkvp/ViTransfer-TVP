// Pure date-string helpers for the production schedule (Gantt) feature.
// All schedule dates are YYYY-MM-DD strings (same convention as ProjectKeyDate,
// avoids timezone drift). Dates are parsed to UTC noon so DST can never shift
// the calendar day.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function parseISODate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`)
}

export function toISODate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isValidISODate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  return toISODate(parseISODate(iso)) === iso
}

export function addDays(iso: string, n: number): string {
  const d = parseISODate(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return toISODate(d)
}

/** 0 = Monday ... 6 = Sunday */
export function weekdayIndex(iso: string): number {
  return (parseISODate(iso).getUTCDay() + 6) % 7
}

export function isWeekend(iso: string): boolean {
  return weekdayIndex(iso) >= 5
}

/** Monday of the ISO week containing the date. */
export function weekStart(iso: string): string {
  return addDays(iso, -weekdayIndex(iso))
}

export function compareISO(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Roll a weekend date forward to the next Monday; weekdays pass through. */
export function rollToBusinessDay(iso: string): string {
  const wd = weekdayIndex(iso)
  if (wd === 5) return addDays(iso, 2) // Saturday -> Monday
  if (wd === 6) return addDays(iso, 1) // Sunday -> Monday
  return iso
}

/**
 * Add n business days (Mon-Fri). A weekend start rolls forward to Monday
 * first, so addBusinessDays(saturday, 0) === the following Monday.
 */
export function addBusinessDays(iso: string, n: number): string {
  let cur = rollToBusinessDay(iso)
  for (let i = 0; i < n; i++) {
    cur = rollToBusinessDay(addDays(cur, 1))
  }
  return cur
}

/** All days from min to max inclusive, optionally skipping weekends. */
export function enumerateScheduleDays(min: string, max: string, includeWeekends: boolean): string[] {
  const out: string[] = []
  let cur = min
  let guard = 0
  while (compareISO(cur, max) <= 0 && guard++ < 5000) {
    if (includeWeekends || !isWeekend(cur)) out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

/** "3", "14" — day-of-month label for the axis. */
export function dayNumber(iso: string): string {
  return String(parseISODate(iso).getUTCDate())
}

/** "3 Jul" */
export function formatShortDate(iso: string): string {
  const d = parseISODate(iso)
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`
}

/** "3 July 2026" */
export function formatLongDate(iso: string): string {
  const d = parseISODate(iso)
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "6 Jul week" — label for a week group header, keyed by its Monday. */
export function weekLabel(weekStartISO: string): string {
  return `${formatShortDate(weekStartISO)} week`
}
