'use client'

import { useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SalesRollupResponse } from '@/lib/sales/admin-api'
import type { SalesSettings } from '@/lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { quoteEffectiveStatus } from '@/lib/sales/status'
import { getInvoiceDashboardAmountCents, getPaymentDashboardAmountCents, getSalesDashboardReportingBasis, salesDashboardIncludesGst } from '@/lib/sales/dashboard-reporting'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeriodKey = 'fy-to-date' | 'last-fy' | 'fy-quarter' | 'last-fy-quarter' | 'ytd' | 'last-12' | 'last-6' | 'last-3' | 'all-time'

interface PeriodMonth {
  key: string   // YYYY-MM
  label: string // e.g. "Jul '25"
}

interface PeriodRange {
  start: Date
  end: Date
  months: PeriodMonth[]
  isAllTime?: boolean
}

function formatCurrencyAmount(
  amount: number,
  currencySymbol: string,
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
): string {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  return `${sign}${currencySymbol}${abs.toLocaleString('en-AU', { minimumFractionDigits, maximumFractionDigits })}`
}

function formatCurrencyCents(cents: number, currencySymbol: string): string {
  return formatCurrencyAmount(cents / 100, currencySymbol)
}

// ---------------------------------------------------------------------------
// Period utilities
// ---------------------------------------------------------------------------

function computePeriod(key: PeriodKey, fyStartMonth: number, now: Date): PeriodRange {
  if (key === 'all-time') {
    return { start: new Date(0), end: new Date(9999, 0, 1), months: [], isAllTime: true }
  }

  const fyStartM = Math.max(1, Math.min(12, fyStartMonth)) - 1 // 0-indexed month
  const currentYear = now.getFullYear()
  const currentFyStartYear =
    now.getMonth() >= fyStartM ? currentYear : currentYear - 1

  let start: Date
  let end: Date

  if (key === 'fy-to-date') {
    start = new Date(currentFyStartYear, fyStartM, 1)
    end = now
  } else if (key === 'last-fy') {
    start = new Date(currentFyStartYear - 1, fyStartM, 1)
    end = new Date(currentFyStartYear, fyStartM, 0, 23, 59, 59, 999)
  } else if (key === 'fy-quarter') {
    const offsetInFy = ((now.getMonth() - fyStartM) + 12) % 12
    const qIdx = Math.floor(offsetInFy / 3)
    const qStartAbsM = fyStartM + qIdx * 3
    start = new Date(currentFyStartYear + Math.floor(qStartAbsM / 12), qStartAbsM % 12, 1)
    end = now
  } else if (key === 'last-fy-quarter') {
    const offsetInFy = ((now.getMonth() - fyStartM) + 12) % 12
    const qIdx = Math.floor(offsetInFy / 3)
    const prevQIdx = qIdx === 0 ? 3 : qIdx - 1
    const prevFyYear = qIdx === 0 ? currentFyStartYear - 1 : currentFyStartYear
    const prevQStartAbsM = fyStartM + prevQIdx * 3
    const prevQEndAbsM = prevQStartAbsM + 3
    start = new Date(prevFyYear + Math.floor(prevQStartAbsM / 12), prevQStartAbsM % 12, 1)
    end = new Date(prevFyYear + Math.floor(prevQEndAbsM / 12), prevQEndAbsM % 12, 0, 23, 59, 59, 999)
  } else if (key === 'ytd') {
    start = new Date(currentYear, 0, 1)
    end = now
  } else if (key === 'last-12') {
    start = new Date(currentYear, now.getMonth() - 11, 1)
    end = now
  } else if (key === 'last-6') {
    start = new Date(currentYear, now.getMonth() - 5, 1)
    end = now
  } else if (key === 'last-3') {
    start = new Date(currentYear, now.getMonth() - 2, 1)
    end = now
  } else {
    // all-time already handled above; fallback to last-3
    start = new Date(currentYear, now.getMonth() - 2, 1)
    end = now
  }

  return { start, end, months: buildMonths(start, end) }
}

function buildMonths(start: Date, end: Date): PeriodMonth[] {
  const months: PeriodMonth[] = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const endBoundary = new Date(end.getFullYear(), end.getMonth(), 1)

  while (cursor <= endBoundary) {
    const yr = cursor.getFullYear()
    const mo = cursor.getMonth() + 1
    const moKey = `${yr}-${String(mo).padStart(2, '0')}`
    const moLabel = cursor.toLocaleString('en-AU', { month: 'short', year: '2-digit' })
    months.push({ key: moKey, label: moLabel })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return months
}

// Same window one year earlier, aligned by fiscal month (Jul '25 pairs with Jul '24).
function shiftPeriodOneYearBack(period: PeriodRange): PeriodRange {
  const start = new Date(period.start)
  start.setFullYear(start.getFullYear() - 1)
  const end = new Date(period.end)
  end.setFullYear(end.getFullYear() - 1)
  return { start, end, months: buildMonths(start, end) }
}

const EMPTY_PERIOD: PeriodRange = { start: new Date(0), end: new Date(0), months: [] }

function isoToYearMonth(iso: string): string {
  // Accepts YYYY-MM-DD or full ISO timestamp
  return iso.slice(0, 7)
}

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'fy-to-date', label: 'Financial year to date' },
  { value: 'last-fy', label: 'Last financial year' },
  { value: 'fy-quarter', label: 'This financial quarter' },
  { value: 'last-fy-quarter', label: 'Last financial quarter' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last-12', label: 'Last 12 months' },
  { value: 'last-6', label: 'Last 6 months' },
  { value: 'last-3', label: 'Last 3 months' },
]

const PERIOD_OPTIONS_WITH_ALL_TIME: { value: PeriodKey; label: string }[] = [
  ...PERIOD_OPTIONS,
  { value: 'all-time', label: 'All time' },
]

// ---------------------------------------------------------------------------
// Custom Tooltip components
// ---------------------------------------------------------------------------

interface TooltipPayloadItem {
  name: string
  value: number
  color: string
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
  currencySymbol?: string
  formatValue?: (val: number, name: string) => string
}

function ChartTooltip({ active, payload, label, formatValue }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2.5 shadow-xl text-sm">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-medium text-foreground">
            {formatValue ? formatValue(entry.value, entry.name) : entry.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------

function PeriodSelect({
  value,
  onChange,
  options = PERIOD_OPTIONS,
}: {
  value: PeriodKey
  onChange: (v: PeriodKey) => void
  options?: { value: PeriodKey; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PeriodKey)}>
      <SelectTrigger className="h-8 w-[200px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Chart 1: Sales Overview
// ---------------------------------------------------------------------------

function useSalesChartData(
  rollup: SalesRollupResponse | null,
  period: PeriodRange,
  settings: SalesSettings,
) {
  return useMemo(() => {
    const monthMap = new Map<string, number>()
    for (const m of period.months) monthMap.set(m.key, 0)

    const invoices = rollup?.invoices ?? []
    const payments = rollup?.payments ?? []
    const rollupById = rollup?.invoiceRollupById ?? {}
    const invoiceById = Object.fromEntries(invoices.map((invoice) => [invoice.id, invoice]))
    const reportingBasis = getSalesDashboardReportingBasis(settings)
    const includeGst = salesDashboardIncludesGst(settings)
    const startMs = period.start.getTime()
    const endMs = period.end.getTime()

    if (reportingBasis === 'CASH') {
      for (const payment of payments) {
        if (payment.excludeFromInvoiceBalance) continue

        const paidAt = new Date(`${payment.paymentDate}T00:00:00`).getTime()
        if (Number.isNaN(paidAt) || paidAt < startMs || paidAt > endMs) continue

        const ym = isoToYearMonth(payment.paymentDate)
        if (!monthMap.has(ym)) continue

        const amountCents = getPaymentDashboardAmountCents(payment, payment.invoiceId ? invoiceById[payment.invoiceId] : null, settings.taxRatePercent, includeGst)
        monthMap.set(ym, (monthMap.get(ym) ?? 0) + amountCents)
      }
    } else {
      for (const inv of invoices) {
        const issuedAt = new Date(`${inv.issueDate}T00:00:00`).getTime()
        if (Number.isNaN(issuedAt) || issuedAt < startMs || issuedAt > endMs) continue

        const ym = isoToYearMonth(inv.issueDate)
        if (!monthMap.has(ym)) continue

        const amountCents = getInvoiceDashboardAmountCents(inv, settings.taxRatePercent, includeGst, rollupById[inv.id])
        monthMap.set(ym, (monthMap.get(ym) ?? 0) + amountCents)
      }
    }

    return period.months.map((m) => ({
      label: m.label,
      revenueCents: monthMap.get(m.key) ?? 0,
      revenue: (monthMap.get(m.key) ?? 0) / 100,
    }))
  }, [rollup, period, settings])
}

interface SalesOverviewChartProps {
  rollup: SalesRollupResponse | null
  settings: SalesSettings
  nowIso: string | null
}

export function SalesOverviewChart({ rollup, settings, nowIso }: SalesOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const [compareLastFy, setCompareLastFy] = useState(false)
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const comparePeriodRange = useMemo(
    () => (compareLastFy ? shiftPeriodOneYearBack(periodRange) : EMPTY_PERIOD),
    [compareLastFy, periodRange],
  )
  const data = useSalesChartData(rollup, periodRange, settings)
  const prevData = useSalesChartData(rollup, comparePeriodRange, settings)
  const sym = getCurrencySymbol(settings.currencyCode)
  const reportingBasis = getSalesDashboardReportingBasis(settings)
  const includeGst = salesDashboardIncludesGst(settings)

  const chartData = useMemo(
    () => data.map((row, i) => ({
      ...row,
      prevRevenue: compareLastFy ? (prevData[i]?.revenue ?? 0) : undefined,
    })),
    [data, prevData, compareLastFy],
  )

  const totalCents = data.reduce((sum, row) => sum + row.revenueCents, 0)
  const prevTotalCents = prevData.reduce((sum, row) => sum + row.revenueCents, 0)
  const hasData = data.some((row) => row.revenueCents > 0) || (compareLastFy && prevTotalCents > 0)

  const monthCount = periodRange.months.length

  // For projections, compute elapsed time more precisely:
  // complete months + fractional progress through the current (partial) month.
  // e.g. 15th of a 30-day month → 0.5 months for the current month.
  const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()
  const currentMonthFraction = dayOfMonth / daysInCurrentMonth
  // Elapsed = (all months in period except last) + fraction of last month
  const elapsedMonths = Math.max(monthCount - 1 + currentMonthFraction, currentMonthFraction)

  const avgPerMonthCents = elapsedMonths > 0 ? Math.round(totalCents / elapsedMonths) : 0

  const showProjection = period === 'fy-to-date' || period === 'ytd'
  // Projected = run-rate × 12 (fy-to-date projects to a full 12-month FY; ytd to full calendar year)
  const projectedCents = showProjection && avgPerMonthCents > 0 ? avgPerMonthCents * 12 : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Sales Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Total: {formatCurrencyCents(totalCents, sym)}
            {avgPerMonthCents > 0 && ` · avg ${formatCurrencyCents(avgPerMonthCents, sym)} / mo`}
            {projectedCents !== null && ` · Projected: ${formatCurrencyCents(projectedCents, sym)}`}
          </p>
          {compareLastFy && prevTotalCents > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Last FY: {formatCurrencyCents(prevTotalCents, sym)}
              {' · '}
              <span className={totalCents >= prevTotalCents ? 'text-emerald-400' : 'text-destructive'}>
                {totalCents >= prevTotalCents ? '▲' : '▼'} {Math.abs(Math.round(((totalCents - prevTotalCents) / prevTotalCents) * 100))}%
              </span>
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">{reportingBasis === 'CASH' ? 'Cash basis' : 'Accrual basis'} · {includeGst ? 'Including GST' : 'Excluding GST'}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <PeriodSelect value={period} onChange={setPeriod} />
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-border"
              checked={compareLastFy}
              onChange={() => setCompareLastFy((v) => !v)}
              aria-label="Compare to last financial year"
            />
            vs last FY
          </label>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {!hasData ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            {reportingBasis === 'CASH' ? 'No payment data for this period' : 'No invoice data for this period'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
              <defs>
                <linearGradient id="salesBarGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity={1} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.8} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) =>
                  v >= 1000 ? `${sym}${(v / 1000).toFixed(0)}k` : `${sym}${Math.round(v).toLocaleString('en-AU')}`
                }
                width={52}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(val) => formatCurrencyAmount(val, sym)}
                  />
                }
                cursor={{ fill: 'currentColor', opacity: 0.05 }}
              />
              <Bar
                dataKey="revenue"
                name="Sales"
                fill="url(#salesBarGradient)"
                radius={[5, 5, 0, 0]}
              />
              {compareLastFy && (
                <Line
                  type="monotone"
                  dataKey="prevRevenue"
                  name="Last FY"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={{ r: 2.5, fill: '#94a3b8', strokeWidth: 0 }}
                  activeDot={{ r: 4.5, fill: '#94a3b8', strokeWidth: 0 }}
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Chart 2: Quotes Overview
// ---------------------------------------------------------------------------

function useQuotesChartData(
  rollup: SalesRollupResponse | null,
  period: PeriodRange,
  nowMs: number,
) {
  return useMemo(() => {
    const totalMap = new Map<string, number>()
    const acceptedMap = new Map<string, number>()
    for (const m of period.months) {
      totalMap.set(m.key, 0)
      acceptedMap.set(m.key, 0)
    }

    const quotes = rollup?.quotes ?? []
    for (const q of quotes) {
      // "Total" — all quotes bucketed by issueDate
      const issueYm = isoToYearMonth(q.issueDate)
      if (totalMap.has(issueYm)) {
        totalMap.set(issueYm, (totalMap.get(issueYm) ?? 0) + 1)
      }

      // "Accepted" — only accepted quotes, bucketed by issueDate
      const effectiveStatus = quoteEffectiveStatus(q, nowMs)
      if (effectiveStatus === 'ACCEPTED') {
        if (acceptedMap.has(issueYm)) {
          acceptedMap.set(issueYm, (acceptedMap.get(issueYm) ?? 0) + 1)
        }
      }
    }

    return period.months.map((m) => ({
      label: m.label,
      total: totalMap.get(m.key) ?? 0,
      accepted: acceptedMap.get(m.key) ?? 0,
    }))
  }, [rollup, period, nowMs])
}

interface QuotesOverviewChartProps {
  rollup: SalesRollupResponse | null
  settings: SalesSettings
  nowIso: string | null
}

export function QuotesOverviewChart({ rollup, settings, nowIso }: QuotesOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const nowMs = now.getTime()
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const data = useQuotesChartData(rollup, periodRange, nowMs)
  const hasData = data.some((d) => d.total > 0 || d.accepted > 0)

  const grandTotal = data.reduce((s, d) => s + d.total, 0)
  const totalAccepted = data.reduce((s, d) => s + d.accepted, 0)
  const acceptanceRate =
    grandTotal > 0 ? Math.round((totalAccepted / grandTotal) * 100) : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Quotes Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {grandTotal} total · {totalAccepted} accepted
            {acceptanceRate !== null && ` · ${acceptanceRate}% win rate`}
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {!hasData ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            No quote data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: 'currentColor', strokeOpacity: 0.1, strokeWidth: 1 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
              <Line
                type="monotone"
                dataKey="total"
                name="Total"
                stroke="#818cf8"
                strokeWidth={2.5}
                dot={{ r: 3, fill: '#818cf8', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#818cf8', strokeWidth: 0 }}
              />
              <Line
                type="monotone"
                dataKey="accepted"
                name="Accepted"
                stroke="#34d399"
                strokeWidth={2.5}
                dot={{ r: 3, fill: '#34d399', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#34d399', strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Revenue contributions — shared, basis-aware input for charts 3 and 4
// ---------------------------------------------------------------------------

/**
 * One unit of recognised revenue. Under CASH basis that is a payment received
 * (dated by paymentDate); under ACCRUAL it is an invoice raised (dated by
 * issueDate). Charts 3 and 4 aggregate these so their period totals reconcile
 * with the Sales Overview chart, which applies the same rules in
 * useSalesChartData. Anything keyed off project.startDate is deliberately gone:
 * it matched neither basis and silently hid clients whose projects were still
 * open or had started in a prior period.
 */
interface RevenueContribution {
  /** YYYY-MM of the recognition date. */
  ym: string
  clientId: string | null
  /**
   * Distinct-count key for "how many projects". The project when the document
   * is linked to one, otherwise the document itself — so unlinked invoices and
   * ad-hoc payments still count as one unit each rather than vanishing from the
   * denominator of an average.
   */
  unitKey: string
  amountCents: number
}

function useRevenueContributions(
  rollup: SalesRollupResponse | null,
  settings: SalesSettings,
  period: PeriodRange,
): RevenueContribution[] {
  return useMemo(() => {
    const invoices = rollup?.invoices ?? []
    const payments = rollup?.payments ?? []
    const rollupById = rollup?.invoiceRollupById ?? {}
    const invoiceById = Object.fromEntries(invoices.map((inv) => [inv.id, inv]))
    const reportingBasis = getSalesDashboardReportingBasis(settings)
    const includeGst = salesDashboardIncludesGst(settings)
    const startMs = period.start.getTime()
    const endMs = period.end.getTime()

    // All-time keeps every dated document; every other period is a window.
    const isInPeriod = (ymd: string): boolean => {
      const ms = new Date(`${ymd}T00:00:00`).getTime()
      if (Number.isNaN(ms)) return false
      if (period.isAllTime) return true
      return ms >= startMs && ms <= endMs
    }

    const out: RevenueContribution[] = []

    if (reportingBasis === 'CASH') {
      for (const payment of payments) {
        if (payment.excludeFromInvoiceBalance) continue
        if (!isInPeriod(payment.paymentDate)) continue

        const invoice = payment.invoiceId ? invoiceById[payment.invoiceId] : null
        const amountCents = getPaymentDashboardAmountCents(
          payment,
          invoice ?? null,
          settings.taxRatePercent,
          includeGst,
        )
        if (amountCents <= 0) continue

        out.push({
          ym: isoToYearMonth(payment.paymentDate),
          clientId: payment.clientId ?? invoice?.clientId ?? null,
          unitKey: invoice?.projectId ? `project:${invoice.projectId}` : `payment:${payment.id}`,
          amountCents,
        })
      }
    } else {
      for (const inv of invoices) {
        if (!isInPeriod(inv.issueDate)) continue

        // Returns 0 for VOID invoices, which are cancelled and earn nothing.
        const amountCents = getInvoiceDashboardAmountCents(
          inv,
          settings.taxRatePercent,
          includeGst,
          rollupById[inv.id],
        )
        if (amountCents <= 0) continue

        out.push({
          ym: isoToYearMonth(inv.issueDate),
          clientId: inv.clientId ?? null,
          unitKey: inv.projectId ? `project:${inv.projectId}` : `invoice:${inv.id}`,
          amountCents,
        })
      }
    }

    return out
  }, [rollup, settings, period])
}

/** Muted one-liner telling the reader which basis produced the numbers. */
function reportingBasisCaption(settings: SalesSettings): string {
  const taxWord = settings.taxLabel?.trim() || 'tax'
  const gst = salesDashboardIncludesGst(settings) ? `incl. ${taxWord}` : `excl. ${taxWord}`
  return getSalesDashboardReportingBasis(settings) === 'CASH'
    ? `Cash basis · payments received (${gst})`
    : `Accrual basis · invoices issued (${gst})`
}

// ---------------------------------------------------------------------------
// Chart 3: Projects Overview
// ---------------------------------------------------------------------------

function useProjectsChartData(
  contributions: RevenueContribution[],
  period: PeriodRange,
) {
  return useMemo(() => {
    const unitsByMonth = new Map<string, Set<string>>()
    const totalMap = new Map<string, number>()
    for (const m of period.months) {
      unitsByMonth.set(m.key, new Set<string>())
      totalMap.set(m.key, 0)
    }

    for (const c of contributions) {
      const units = unitsByMonth.get(c.ym)
      if (!units) continue
      units.add(c.unitKey)
      totalMap.set(c.ym, (totalMap.get(c.ym) ?? 0) + c.amountCents)
    }

    return period.months.map((m) => {
      const count = unitsByMonth.get(m.key)?.size ?? 0
      const total = totalMap.get(m.key) ?? 0
      const avg = count > 0 ? Math.round(total / count / 100) : 0
      return {
        label: m.label,
        count,
        avg,
      }
    })
  }, [contributions, period])
}

interface ProjectsOverviewChartProps {
  rollup: SalesRollupResponse | null
  settings: SalesSettings
  nowIso: string | null
}

export function ProjectsOverviewChart({ rollup, settings, nowIso }: ProjectsOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')

  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const contributions = useRevenueContributions(rollup, settings, periodRange)
  const data = useProjectsChartData(contributions, periodRange)
  const sym = getCurrencySymbol(settings.currencyCode)

  // Distinct across the whole period — summing the monthly counts would
  // double-count a project that earned revenue in more than one month.
  const totalProjects = useMemo(
    () => new Set(contributions.map((c) => c.unitKey)).size,
    [contributions],
  )
  const totalRevCents = contributions.reduce((s, c) => s + c.amountCents, 0)
  const overallAvg =
    totalProjects > 0 ? Math.round(totalRevCents / totalProjects / 100) : 0

  const loading = rollup === null
  const hasData = data.some((d) => d.count > 0)

  return (
    <Card className="overflow-hidden flex flex-col h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Projects Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalProjects} {totalProjects === 1 ? 'project' : 'projects'}
            {overallAvg > 0 && ` · avg ${sym}${overallAvg.toLocaleString('en-AU')} / project`}
          </p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">{reportingBasisCaption(settings)}</p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0 flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col min-h-[220px]">
        {loading ? (
          <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
            No project revenue for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
            <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="30%">
              <defs>
                <linearGradient id="projectBarGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a78bfa" stopOpacity={1} />
                  <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.75} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
              />
              {/* Left axis — project count */}
              <YAxis
                yAxisId="left"
                allowDecimals={false}
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
                width={28}
              />
              {/* Right axis — avg project value */}
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.55 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) =>
                  v >= 10000 ? `${sym}${(v / 1000).toFixed(0)}k`
                  : v >= 1000 ? `${sym}${(v / 1000).toFixed(1)}k`
                  : `${sym}${v}`
                }
                width={44}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(val, name) =>
                      name === 'Avg value'
                        ? `${sym}${val.toLocaleString('en-AU')}`
                        : String(val)
                    }
                  />
                }
                cursor={{ fill: 'currentColor', opacity: 0.05 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
              <Bar
                yAxisId="left"
                dataKey="count"
                name="Projects"
                fill="url(#projectBarGradient)"
                radius={[5, 5, 0, 0]}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avg"
                name="Avg value"
                stroke="#f59e0b"
                strokeWidth={2.5}
                dot={{ r: 3.5, fill: '#f59e0b', strokeWidth: 0 }}
                activeDot={{ r: 5.5, fill: '#f59e0b', strokeWidth: 0 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Chart 4: Clients Overview (leaderboard)
// ---------------------------------------------------------------------------

interface ClientLeaderboardRow {
  clientId: string
  clientName: string
  /** Projects that earned revenue in the period (unlinked documents count as one each). */
  projectCount: number
  totalCents: number
  avgCents: number
}

function useClientsLeaderboard(
  contributions: RevenueContribution[],
  clientNameById: Record<string, string>,
): ClientLeaderboardRow[] {
  return useMemo(() => {
    const map = new Map<string, { totalCents: number; units: Set<string> }>()

    for (const c of contributions) {
      if (!c.clientId) continue
      let entry = map.get(c.clientId)
      if (!entry) {
        entry = { totalCents: 0, units: new Set<string>() }
        map.set(c.clientId, entry)
      }
      entry.totalCents += c.amountCents
      entry.units.add(c.unitKey)
    }

    return [...map.entries()]
      .map(([clientId, entry]) => ({
        clientId,
        clientName: clientNameById[clientId] ?? 'Unknown client',
        projectCount: entry.units.size,
        totalCents: entry.totalCents,
        avgCents: entry.units.size > 0 ? Math.round(entry.totalCents / entry.units.size) : 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents)
  }, [contributions, clientNameById])
}

const RANK_COLORS = [
  'from-amber-400 to-yellow-300',   // #1 gold
  'from-slate-400 to-slate-300',    // #2 silver
  'from-orange-500 to-amber-400',   // #3 bronze
]

interface ClientsOverviewChartProps {
  rollup: SalesRollupResponse | null
  clientNameById: Record<string, string>
  clientNamesLoaded: boolean
  settings: SalesSettings
  nowIso: string | null
}

export function ClientsOverviewChart({ rollup, clientNameById, clientNamesLoaded, settings, nowIso }: ClientsOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')

  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const contributions = useRevenueContributions(rollup, settings, periodRange)
  const rows = useClientsLeaderboard(contributions, clientNameById)
  const sym = getCurrencySymbol(settings.currencyCode)

  const loading = rollup === null || !clientNamesLoaded
  const maxTotal = rows[0]?.totalCents ?? 1
  const grandTotal = rows.reduce((s, r) => s + r.totalCents, 0)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Clients Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rows.length} {rows.length === 1 ? 'client' : 'clients'} · {sym}{Math.round(grandTotal / 100).toLocaleString('en-AU')} total revenue
          </p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">{reportingBasisCaption(settings)}</p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} options={PERIOD_OPTIONS_WITH_ALL_TIME} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[120px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-[120px] text-sm text-muted-foreground">
            {period === 'all-time' ? 'No client revenue yet.' : 'No client revenue for this period.'}
          </div>
        ) : (
          <div className="overflow-y-auto max-h-[340px] space-y-2 pr-1">
            {rows.map((row, idx) => {
              const pct = maxTotal > 0 ? (row.totalCents / maxTotal) * 100 : 0
              const total = Math.round(row.totalCents / 100)
              const avg = Math.round(row.avgCents / 100)
              const rankColor = RANK_COLORS[idx] ?? 'from-indigo-400 to-indigo-300'
              const isTopThree = idx < 3

              return (
                <div key={row.clientId} className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                  {/* Rank badge */}
                  <div
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white bg-linear-to-br ${isTopThree ? rankColor : 'from-muted-foreground/40 to-muted-foreground/20'}`}
                  >
                    {idx + 1}
                  </div>

                  {/* Name + bar + stats */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <a
                        href={`/admin/clients/${encodeURIComponent(row.clientId)}`}
                        className="text-sm font-medium truncate hover:underline underline-offset-2"
                      >
                        {row.clientName}
                      </a>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {sym}{total.toLocaleString('en-AU')}
                      </span>
                    </div>

                    {/* Relative progress bar */}
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-1.5">
                      <div
                        className={`h-full rounded-full bg-linear-to-r ${isTopThree ? rankColor : 'from-indigo-500 to-indigo-400'} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {row.projectCount} {row.projectCount === 1 ? 'project' : 'projects'}
                      {avg > 0 && ` · avg ${sym}${avg.toLocaleString('en-AU')}`}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main export — all four charts
// ---------------------------------------------------------------------------

export interface SalesDashboardChartsProps {
  rollup: SalesRollupResponse | null
  /** Client id → display name, used by the Clients Overview leaderboard. */
  clientNameById: Record<string, string>
  /** True once the client lookup has resolved (successfully or not). */
  clientNamesLoaded: boolean
  settings: SalesSettings
  nowIso: string | null
}

export function SalesDashboardCharts({ rollup, clientNameById, clientNamesLoaded, settings, nowIso }: SalesDashboardChartsProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SalesOverviewChart rollup={rollup} settings={settings} nowIso={nowIso} />
        <QuotesOverviewChart rollup={rollup} settings={settings} nowIso={nowIso} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProjectsOverviewChart rollup={rollup} settings={settings} nowIso={nowIso} />
        <ClientsOverviewChart
          rollup={rollup}
          clientNameById={clientNameById}
          clientNamesLoaded={clientNamesLoaded}
          settings={settings}
          nowIso={nowIso}
        />
      </div>
    </div>
  )
}
