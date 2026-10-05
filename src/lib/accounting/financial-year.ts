/**
 * Australian financial year helpers (1 July – 30 June).
 *
 * BasPeriod.financialYear stores the FY by its ENDING year as a plain 4-digit
 * string ("2026" = Jul 2025 – Jun 2026), matching the ATO's "2026 income year".
 */

/** Ending year of the FY containing `now` (Oct 2026 → 2027). */
export function currentFinancialYearEnd(now: Date = new Date()): number {
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()
}
