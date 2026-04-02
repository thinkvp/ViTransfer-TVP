type DateLike = Date | string | null | undefined

function asValidDate(value: DateLike): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function parseProjectStartDateInput(value: string): Date | null {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null

  const [year, month, day] = trimmed.split('-').map(Number)
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return Number.isNaN(date.getTime()) ? null : date
}

export function toLocalYmd(value: DateLike): string | null {
  const date = asValidDate(value)
  if (!date) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getEffectiveStartDate(startDate: DateLike, createdAt: DateLike): Date | null {
  return asValidDate(startDate) ?? asValidDate(createdAt)
}

export function getEffectiveStartDateYmd(startDate: DateLike, createdAt: DateLike): string | null {
  return toLocalYmd(startDate) ?? toLocalYmd(createdAt)
}

export function isStartDateDue(startDate: DateLike, createdAt: DateLike, now: Date = new Date()): boolean {
  const effectiveYmd = getEffectiveStartDateYmd(startDate, createdAt)
  const todayYmd = toLocalYmd(now)
  return Boolean(effectiveYmd && todayYmd && effectiveYmd <= todayYmd)
}
