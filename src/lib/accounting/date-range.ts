/**
 * Prisma date filters for report ranges that may be open at either end.
 *
 * Accounting date columns are `YYYY-MM-DD` strings, so a bound is simply
 * omitted rather than widened to a sentinel date: an absent bound means "no
 * constraint", which is what an all-time report asks for. Returns `undefined`
 * when both ends are open — Prisma drops an undefined filter entirely.
 */
export type ReportDateFilter = { gte?: string; lte?: string } | undefined

export function reportDateFilter(startDate: string | null, endDate: string | null): ReportDateFilter {
  if (!startDate && !endDate) return undefined
  return {
    ...(startDate ? { gte: startDate } : {}),
    ...(endDate ? { lte: endDate } : {}),
  }
}
