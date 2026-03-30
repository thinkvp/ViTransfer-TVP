'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
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
import { apiFetch } from '@/lib/api-client'
import type { SalesRollupResponse } from '@/lib/sales/admin-api'
import type { SalesSettings } from '@/lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { quoteEffectiveStatus } from '@/lib/sales/status'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeriodKey = 'fy-to-date' | 'last-fy' | 'ytd' | 'last-12'

interface PeriodMonth {
  key: string   // YYYY-MM
  label: string // e.g. "Jul '25"
}

interface PeriodRange {
  start: Date
  end: Date
  months: PeriodMonth[]
}

interface ProjectChartRow {
  id: string
  createdAt: string
  totalInvoicedCents: number
  clientId: string | null
  clientName: string | null
}

// ---------------------------------------------------------------------------
// Period utilities
// ---------------------------------------------------------------------------

function computePeriod(key: PeriodKey, fyStartMonth: number, now: Date): PeriodRange {
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
  } else if (key === 'ytd') {
    start = new Date(currentYear, 0, 1)
    end = now
  } else {
    // last-12: first day of same month 12 months back → today
    start = new Date(currentYear, now.getMonth() - 11, 1)
    end = now
  }

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

  return { start, end, months }
}

function isoToYearMonth(iso: string): string {
  // Accepts YYYY-MM-DD or full ISO timestamp
  return iso.slice(0, 7)
}

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'fy-to-date', label: 'Financial year to date' },
  { value: 'last-fy', label: 'Last financial year' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last-12', label: 'Last 12 months' },
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
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
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
}: {
  value: PeriodKey
  onChange: (v: PeriodKey) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PeriodKey)}>
      <SelectTrigger className="h-8 w-[200px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIOD_OPTIONS.map((opt) => (
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
  taxRatePercent: number,
) {
  return useMemo(() => {
    const monthMap = new Map<string, number>()
    for (const m of period.months) monthMap.set(m.key, 0)

    const invoices = rollup?.invoices ?? []
    const rollupById = rollup?.invoiceRollupById ?? {}

    for (const inv of invoices) {
      const ym = isoToYearMonth(inv.issueDate)
      if (!monthMap.has(ym)) continue

      const r = rollupById[inv.id]
      const totalCents = r?.totalCents != null
        ? Number(r.totalCents)
        : sumLineItemsSubtotal(inv.items) + sumLineItemsTax(inv.items, taxRatePercent)

      monthMap.set(ym, (monthMap.get(ym) ?? 0) + Math.max(0, Math.trunc(totalCents)))
    }

    return period.months.map((m) => ({
      label: m.label,
      revenue: Math.round((monthMap.get(m.key) ?? 0) / 100),
    }))
  }, [rollup, period, taxRatePercent])
}

interface SalesOverviewChartProps {
  rollup: SalesRollupResponse | null
  settings: SalesSettings
  nowIso: string | null
}

export function SalesOverviewChart({ rollup, settings, nowIso }: SalesOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const data = useSalesChartData(rollup, periodRange, settings.taxRatePercent)
  const sym = getCurrencySymbol(settings.currencyCode)

  const total = data.reduce((s, d) => s + d.revenue, 0)
  const hasData = data.some((d) => d.revenue > 0)

  const monthCount = periodRange.months.length

  // For projections, compute elapsed time more precisely:
  // complete months + fractional progress through the current (partial) month.
  // e.g. 15th of a 30-day month → 0.5 months for the current month.
  const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()
  const currentMonthFraction = dayOfMonth / daysInCurrentMonth
  // Elapsed = (all months in period except last) + fraction of last month
  const elapsedMonths = Math.max(monthCount - 1 + currentMonthFraction, currentMonthFraction)

  const avgPerMonth = elapsedMonths > 0 ? Math.round(total / elapsedMonths) : 0

  const showProjection = period === 'fy-to-date' || period === 'ytd'
  // Projected = run-rate × 12 (fy-to-date projects to a full 12-month FY; ytd to full calendar year)
  const projected = showProjection && avgPerMonth > 0 ? avgPerMonth * 12 : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Sales Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Total: {sym}{total.toLocaleString('en-AU')}
            {avgPerMonth > 0 && ` · avg ${sym}${avgPerMonth.toLocaleString('en-AU')} / mo`}
            {projected !== null && ` · Projected: ${sym}${projected.toLocaleString('en-AU')}`}
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {!hasData ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            No invoice data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
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
                  v >= 1000 ? `${sym}${(v / 1000).toFixed(0)}k` : `${sym}${v}`
                }
                width={52}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(val) => `${sym}${val.toLocaleString('en-AU')}`}
                  />
                }
                cursor={{ fill: 'currentColor', opacity: 0.05 }}
              />
              <Bar
                dataKey="revenue"
                name="Revenue"
                fill="url(#salesBarGradient)"
                radius={[5, 5, 0, 0]}
              />
            </BarChart>
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
// Chart 3: Projects Overview
// ---------------------------------------------------------------------------

function useProjectsChartData(
  projects: ProjectChartRow[],
  period: PeriodRange,
) {
  return useMemo(() => {
    const countMap = new Map<string, number>()
    const totalMap = new Map<string, number>()
    for (const m of period.months) {
      countMap.set(m.key, 0)
      totalMap.set(m.key, 0)
    }

    for (const p of projects) {
      const ym = isoToYearMonth(p.createdAt)
      if (!countMap.has(ym)) continue
      countMap.set(ym, (countMap.get(ym) ?? 0) + 1)
      totalMap.set(ym, (totalMap.get(ym) ?? 0) + p.totalInvoicedCents)
    }

    return period.months.map((m) => {
      const count = countMap.get(m.key) ?? 0
      const total = totalMap.get(m.key) ?? 0
      const avg = count > 0 ? Math.round(total / count / 100) : 0
      return {
        label: m.label,
        count,
        avg,
      }
    })
  }, [projects, period])
}

interface ProjectsOverviewChartProps {
  projects: ProjectChartRow[]
  loading: boolean
  settings: SalesSettings
  nowIso: string | null
}

export function ProjectsOverviewChart({ projects, loading, settings, nowIso }: ProjectsOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')

  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const data = useProjectsChartData(projects, periodRange)
  const sym = getCurrencySymbol(settings.currencyCode)

  const totalProjects = data.reduce((s, d) => s + d.count, 0)
  const totalRevCents = projects
    .filter((p) => {
      const ym = isoToYearMonth(p.createdAt)
      return periodRange.months.some((m) => m.key === ym)
    })
    .reduce((s, p) => s + p.totalInvoicedCents, 0)
  const overallAvg =
    totalProjects > 0 ? Math.round(totalRevCents / totalProjects / 100) : 0

  const hasData = data.some((d) => d.count > 0)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Projects Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalProjects} closed{' '}
            {overallAvg > 0 && `· avg ${sym}${overallAvg.toLocaleString('en-AU')} / project`}
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            No closed projects for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
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
  projectCount: number
  totalInvoicedCents: number
  avgInvoicedCents: number
}

function useClientsLeaderboard(
  projects: ProjectChartRow[],
  period: PeriodRange,
): ClientLeaderboardRow[] {
  return useMemo(() => {
    const periodMonthSet = new Set(period.months.map((m) => m.key))
    const map = new Map<string, ClientLeaderboardRow>()

    for (const p of projects) {
      const ym = isoToYearMonth(p.createdAt)
      if (!periodMonthSet.has(ym)) continue
      if (!p.clientId) continue

      const existing = map.get(p.clientId)
      if (existing) {
        existing.projectCount += 1
        existing.totalInvoicedCents += p.totalInvoicedCents
        existing.avgInvoicedCents = Math.round(existing.totalInvoicedCents / existing.projectCount)
      } else {
        map.set(p.clientId, {
          clientId: p.clientId,
          clientName: p.clientName ?? 'Unknown client',
          projectCount: 1,
          totalInvoicedCents: p.totalInvoicedCents,
          avgInvoicedCents: p.totalInvoicedCents,
        })
      }
    }

    return [...map.values()].sort((a, b) => b.totalInvoicedCents - a.totalInvoicedCents)
  }, [projects, period])
}

const RANK_COLORS = [
  'from-amber-400 to-yellow-300',   // #1 gold
  'from-slate-400 to-slate-300',    // #2 silver
  'from-orange-500 to-amber-400',   // #3 bronze
]

interface ClientsOverviewChartProps {
  projects: ProjectChartRow[]
  loading: boolean
  settings: SalesSettings
  nowIso: string | null
}

export function ClientsOverviewChart({ projects, loading, settings, nowIso }: ClientsOverviewChartProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')

  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso])
  const periodRange = useMemo(
    () => computePeriod(period, settings.fiscalYearStartMonth ?? 7, now),
    [period, settings.fiscalYearStartMonth, now],
  )
  const rows = useClientsLeaderboard(projects, periodRange)
  const sym = getCurrencySymbol(settings.currencyCode)

  const maxTotal = rows[0]?.totalInvoicedCents ?? 1
  const grandTotal = rows.reduce((s, r) => s + r.totalInvoicedCents, 0)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Clients Overview</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rows.length} clients · {sym}{Math.round(grandTotal / 100).toLocaleString('en-AU')} total revenue
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[120px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-[120px] text-sm text-muted-foreground">
            No closed projects for this period
          </div>
        ) : (
          <div className="overflow-y-auto max-h-[340px] space-y-2 pr-1">
            {rows.map((row, idx) => {
              const pct = maxTotal > 0 ? (row.totalInvoicedCents / maxTotal) * 100 : 0
              const total = Math.round(row.totalInvoicedCents / 100)
              const avg = Math.round(row.avgInvoicedCents / 100)
              const rankColor = RANK_COLORS[idx] ?? 'from-indigo-400 to-indigo-300'
              const isTopThree = idx < 3

              return (
                <div key={row.clientId} className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                  {/* Rank badge */}
                  <div
                    className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white bg-gradient-to-br ${isTopThree ? rankColor : 'from-muted-foreground/40 to-muted-foreground/20'}`}
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
                      <span className="flex-shrink-0 text-sm font-semibold tabular-nums">
                        {sym}{total.toLocaleString('en-AU')}
                      </span>
                    </div>

                    {/* Relative progress bar */}
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-1.5">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${isTopThree ? rankColor : 'from-indigo-500 to-indigo-400'} transition-all duration-500`}
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
  settings: SalesSettings
  nowIso: string | null
}

export function SalesDashboardCharts({ rollup, settings, nowIso }: SalesDashboardChartsProps) {
  const [projects, setProjects] = useState<ProjectChartRow[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setProjectsLoading(true)
    apiFetch('/api/admin/sales/projects-chart', { method: 'GET' })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        setProjects(Array.isArray(json.projects) ? json.projects : [])
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SalesOverviewChart rollup={rollup} settings={settings} nowIso={nowIso} />
        <QuotesOverviewChart rollup={rollup} settings={settings} nowIso={nowIso} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProjectsOverviewChart projects={projects} loading={projectsLoading} settings={settings} nowIso={nowIso} />
        <ClientsOverviewChart projects={projects} loading={projectsLoading} settings={settings} nowIso={nowIso} />
      </div>
    </div>
  )
}
