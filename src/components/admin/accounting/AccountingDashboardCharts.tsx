'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
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
import { getCurrencySymbol } from '@/lib/sales/currency'
import type { ProfitLossReport, ProfitLossSection } from '@/lib/accounting/types'
import { cn } from '@/lib/utils'

// ── Period utilities ──────────────────────────────────────────────────────────

type PeriodKey = 'fy-to-date' | 'last-fy' | 'ytd' | 'last-12'

interface PeriodRange {
  from: string
  to: string
  months: { key: string; label: string }[]
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function computePeriod(key: PeriodKey, fyStartMonth: number, now: Date): PeriodRange {
  const fyStartM = Math.max(1, Math.min(12, fyStartMonth)) - 1
  const y = now.getFullYear()
  const fyStartYear = now.getMonth() >= fyStartM ? y : y - 1

  let start: Date
  let end: Date

  if (key === 'fy-to-date') {
    start = new Date(fyStartYear, fyStartM, 1)
    end = now
  } else if (key === 'last-fy') {
    start = new Date(fyStartYear - 1, fyStartM, 1)
    end = new Date(fyStartYear, fyStartM, 0, 23, 59, 59)
  } else if (key === 'ytd') {
    start = new Date(y, 0, 1)
    end = now
  } else {
    // last-12
    start = new Date(y, now.getMonth() - 11, 1)
    end = now
  }

  const months: { key: string; label: string }[] = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const endBound = new Date(end.getFullYear(), end.getMonth(), 1)
  while (cursor <= endBound) {
    const yr = cursor.getFullYear()
    const mo = cursor.getMonth() + 1
    months.push({
      key: `${yr}-${String(mo).padStart(2, '0')}`,
      label: cursor.toLocaleString('en-AU', { month: 'short', year: '2-digit' }),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return { from: toIso(start), to: toIso(end), months }
}

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'fy-to-date', label: 'Financial year to date' },
  { value: 'last-fy', label: 'Last financial year' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last-12', label: 'Last 12 months' },
]

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

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtAudShort(cents: number, sym: string): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  if (abs >= 1_000_000) return `${sign}${sym}${(abs / 100_000).toFixed(1)}k` // $1.2M → keep k
  if (abs >= 100_000) return `${sign}${sym}${(abs / 100_000).toFixed(0)}k`   // typo-safe k
  return `${sign}${sym}${(abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtAudFull(cents: number, sym: string): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${sym}${(abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function yTickFormatter(sym: string) {
  return (v: number) => {
    const sign = v < 0 ? '-' : ''
    const abs = Math.abs(v)
    if (abs >= 10000) return `${sign}${sym}${(abs / 1000).toFixed(0)}k`
    if (abs >= 1000) return `${sign}${sym}${(abs / 1000).toFixed(1)}k`
    return `${sign}${sym}${Math.round(abs)}`
  }
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

interface TooltipPayloadItem {
  name: string
  value: number
  color: string
}

function ChartTooltip({
  active,
  payload,
  label,
  sym,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
  sym: string
}) {
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
          <span className="font-medium text-foreground">{fmtAudFull(entry.value * 100, sym)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthlyPLPoint {
  yearMonth: string
  incomeCents: number
  cogsCents: number
  expenseCents: number
  netProfitCents: number
}

export interface AccountingDashboardChartsProps {
  reportingBasis: 'CASH' | 'ACCRUAL'
  fyStartMonth: number
  currencyCode: string
}

// ── Chart 1: Profitability Trend ──────────────────────────────────────────────

export function AccountingTrendChart({
  reportingBasis,
  fyStartMonth,
  currencyCode,
}: AccountingDashboardChartsProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const sym = getCurrencySymbol(currencyCode)
  const now = useMemo(() => new Date(), [])
  const periodRange = useMemo(
    () => computePeriod(period, fyStartMonth, now),
    [period, fyStartMonth, now],
  )

  const [monthlyData, setMonthlyData] = useState<MonthlyPLPoint[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({
      from: periodRange.from,
      to: periodRange.to,
      basis: reportingBasis,
    })
    apiFetch(`/api/admin/accounting/reports/profit-loss-monthly?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setMonthlyData(Array.isArray(json.months) ? json.months : [])
      })
      .catch(() => {
        if (!cancelled) setMonthlyData([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodRange.from, periodRange.to, reportingBasis])

  const data = useMemo(() => {
    const labelMap = new Map(periodRange.months.map((m) => [m.key, m.label]))
    return monthlyData.map((m) => ({
      label: labelMap.get(m.yearMonth) ?? m.yearMonth,
      income: m.incomeCents / 100,
      totalCosts: (m.cogsCents + m.expenseCents) / 100,
      netProfit: m.netProfitCents / 100,
    }))
  }, [monthlyData, periodRange.months])

  const totalIncomeCents = useMemo(
    () => monthlyData.reduce((s, m) => s + m.incomeCents, 0),
    [monthlyData],
  )
  const totalCogsCents = useMemo(
    () => monthlyData.reduce((s, m) => s + m.cogsCents, 0),
    [monthlyData],
  )
  const totalNetProfitCents = useMemo(
    () => monthlyData.reduce((s, m) => s + m.netProfitCents, 0),
    [monthlyData],
  )

  const grossMarginPct =
    totalIncomeCents > 0
      ? Math.round(((totalIncomeCents - totalCogsCents) / totalIncomeCents) * 100)
      : null

  const hasData = data.some((d) => d.income > 0 || d.totalCosts > 0)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Profitability Trend</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Income: {fmtAudShort(totalIncomeCents, sym)}
            {' · '}
            <span
              className={
                totalNetProfitCents >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-destructive'
              }
            >
              {totalNetProfitCents >= 0 ? 'Net Profit' : 'Net Loss'}:{' '}
              {fmtAudShort(totalNetProfitCents, sym)}
            </span>
            {grossMarginPct !== null && ` · Gross margin: ${grossMarginPct}%`}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {reportingBasis === 'CASH' ? 'Cash basis' : 'Accrual basis'} · ex GST
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[240px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex items-center justify-center h-[240px] text-sm text-muted-foreground">
            No data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                strokeOpacity={0.08}
                vertical={false}
              />
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
                tickFormatter={yTickFormatter(sym)}
                width={56}
              />
              <ReferenceLine
                y={0}
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeDasharray="4 4"
              />
              <Tooltip
                content={(props) => (
                  <ChartTooltip
                    active={props.active}
                    payload={props.payload as unknown as TooltipPayloadItem[] | undefined}
                    label={props.label as string | undefined}
                    sym={sym}
                  />
                )}
                cursor={{ stroke: 'currentColor', strokeOpacity: 0.1, strokeWidth: 1 }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={8} />
              <Line
                type="monotone"
                dataKey="income"
                name="Income"
                stroke="#34d399"
                strokeWidth={2.5}
                dot={{ r: 3, fill: '#34d399', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#34d399', strokeWidth: 0 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="totalCosts"
                name="Total Costs"
                stroke="#f87171"
                strokeWidth={2.5}
                dot={{ r: 3, fill: '#f87171', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#f87171', strokeWidth: 0 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="netProfit"
                name="Net Profit"
                stroke="#818cf8"
                strokeWidth={2.5}
                strokeDasharray="6 3"
                dot={{ r: 3, fill: '#818cf8', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#818cf8', strokeWidth: 0 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Shared: P&L data hook ─────────────────────────────────────────────────────

function useProfitLossReport(
  from: string,
  to: string,
  basis: 'CASH' | 'ACCRUAL',
): { report: ProfitLossReport | null; loading: boolean } {
  const [report, setReport] = useState<ProfitLossReport | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ from, to, basis })
    apiFetch(`/api/admin/accounting/reports/profit-loss?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setReport(json.report ?? null)
      })
      .catch(() => {
        if (!cancelled) setReport(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [from, to, basis])

  return { report, loading }
}

// ── Shared: Leaderboard row component ─────────────────────────────────────────

type RowSection = 'INCOME' | 'COGS' | 'EXPENSE'

const SECTION_GRADIENT: Record<RowSection, string> = {
  INCOME: 'from-emerald-400 to-green-400',
  COGS: 'from-amber-400 to-yellow-300',
  EXPENSE: 'from-rose-500 to-red-400',
}

const SECTION_BADGE: Record<RowSection, { label: string; className: string }> = {
  INCOME: { label: 'Income', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  COGS: { label: 'COGS', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  EXPENSE: { label: 'Expense', className: 'bg-rose-500/15 text-rose-700 dark:text-rose-400' },
}

interface LeaderboardEntry {
  accountId: string | null
  accountCode: string | null
  displayName: string
  amountCents: number
  section: RowSection
}

function Leaderboard({
  rows,
  sym,
  from,
  to,
  showSectionBadge = false,
}: {
  rows: LeaderboardEntry[]
  sym: string
  from: string
  to: string
  showSectionBadge?: boolean
}) {
  const maxCents = rows.reduce((m, r) => (r.amountCents > m ? r.amountCents : m), 1)

  return (
    <div className="overflow-y-auto max-h-[320px] space-y-1 pr-1">
      {rows.map((row, idx) => {
        const pct = (row.amountCents / maxCents) * 100
        const isLinkable =
          row.accountCode &&
          row.accountId &&
          !row.accountId.startsWith('__')

        return (
          <div
            key={row.accountId ?? idx}
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  {showSectionBadge && (
                    <span
                      className={cn(
                        'flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded',
                        SECTION_BADGE[row.section].className,
                      )}
                    >
                      {SECTION_BADGE[row.section].label}
                    </span>
                  )}
                  {isLinkable ? (
                    <a
                      href={`/admin/accounting/chart-of-accounts/${encodeURIComponent(row.accountCode!)}?from=${from}&to=${to}`}
                      className="text-sm font-medium truncate hover:underline underline-offset-2"
                    >
                      {row.displayName}
                    </a>
                  ) : (
                    <span className="text-sm font-medium truncate">
                      {row.displayName}
                    </span>
                  )}
                </div>
                <span className="flex-shrink-0 text-sm font-semibold tabular-nums">
                  {fmtAudFull(row.amountCents, sym)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full bg-gradient-to-r transition-all duration-500',
                    SECTION_GRADIENT[row.section],
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Chart 2: Income Breakdown ──────────────────────────────────────────────────

export function IncomeBreakdownChart({
  reportingBasis,
  fyStartMonth,
  currencyCode,
}: AccountingDashboardChartsProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const sym = getCurrencySymbol(currencyCode)
  const now = useMemo(() => new Date(), [])
  const periodRange = useMemo(
    () => computePeriod(period, fyStartMonth, now),
    [period, fyStartMonth, now],
  )

  const { report, loading } = useProfitLossReport(
    periodRange.from,
    periodRange.to,
    reportingBasis,
  )

  const rows = useMemo<LeaderboardEntry[]>(() => {
    if (!report) return []
    let lastParentName = ''
    const withDisplayNames = report.income.map((row: ProfitLossSection) => {
      if (!row.depth) lastParentName = row.accountName
      const displayName = row.depth && lastParentName
        ? `${lastParentName} - ${row.accountName}`
        : row.accountName
      return { row, displayName }
    })
    return withDisplayNames
      .filter(({ row }) => !row.hideAmount && row.amountCents > 0)
      .map(({ row, displayName }) => ({
        accountId: row.accountId,
        accountCode: row.accountCode,
        displayName,
        amountCents: row.amountCents,
        section: 'INCOME' as const,
      }))
      .sort((a, b) => b.amountCents - a.amountCents)
  }, [report])

  const grossMarginPct =
    report && report.totalIncomeCents > 0
      ? Math.round(((report.totalIncomeCents - report.totalCogsCents) / report.totalIncomeCents) * 100)
      : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Income Breakdown</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {report
              ? `Total: ${fmtAudFull(report.totalIncomeCents, sym)}${grossMarginPct !== null ? ` · Gross margin: ${grossMarginPct}%` : ''}`
              : 'By account'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {reportingBasis === 'CASH' ? 'Cash basis' : 'Accrual basis'} · ex GST
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[180px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-[180px] text-sm text-muted-foreground">
            No income data for this period
          </div>
        ) : (
          <Leaderboard
            rows={rows}
            sym={sym}
            from={periodRange.from}
            to={periodRange.to}
          />
        )}
      </CardContent>
    </Card>
  )
}

// ── Chart 3: Expense Breakdown (COGS + Operating Expenses) ────────────────────

export function ExpenseBreakdownChart({
  reportingBasis,
  fyStartMonth,
  currencyCode,
}: AccountingDashboardChartsProps) {
  const [period, setPeriod] = useState<PeriodKey>('fy-to-date')
  const sym = getCurrencySymbol(currencyCode)
  const now = useMemo(() => new Date(), [])
  const periodRange = useMemo(
    () => computePeriod(period, fyStartMonth, now),
    [period, fyStartMonth, now],
  )

  const { report, loading } = useProfitLossReport(
    periodRange.from,
    periodRange.to,
    reportingBasis,
  )

  const rows = useMemo<LeaderboardEntry[]>(() => {
    if (!report) return []
    function buildEntries(sections: ProfitLossSection[], section: 'COGS' | 'EXPENSE'): LeaderboardEntry[] {
      let lastParentName = ''
      const withDisplayNames = sections.map((row: ProfitLossSection) => {
        if (!row.depth) lastParentName = row.accountName
        const displayName = row.depth && lastParentName
          ? `${lastParentName} - ${row.accountName}`
          : row.accountName
        return { row, displayName }
      })
      return withDisplayNames
        .filter(({ row }) => !row.hideAmount && row.amountCents > 0)
        .map(({ row, displayName }) => ({
          accountId: row.accountId,
          accountCode: row.accountCode,
          displayName,
          amountCents: row.amountCents,
          section,
        }))
    }
    return [
      ...buildEntries(report.cogs, 'COGS'),
      ...buildEntries(report.expenses, 'EXPENSE'),
    ].sort((a, b) => b.amountCents - a.amountCents)
  }, [report])

  const totalCents = report
    ? report.totalCogsCents + report.totalExpenseCents
    : 0

  const expenseRatioPct =
    report && report.totalIncomeCents > 0
      ? Math.round((totalCents / report.totalIncomeCents) * 100)
      : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Expense Breakdown</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {report
              ? `Total: ${fmtAudFull(totalCents, sym)}${expenseRatioPct !== null ? ` · ${expenseRatioPct}% of income` : ''}`
              : 'COGS and operating expenses by account'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {reportingBasis === 'CASH' ? 'Cash basis' : 'Accrual basis'} · ex GST
          </p>
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-[180px] text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-[180px] text-sm text-muted-foreground">
            No expense data for this period
          </div>
        ) : (
          <Leaderboard
            rows={rows}
            sym={sym}
            from={periodRange.from}
            to={periodRange.to}
            showSectionBadge
          />
        )}
      </CardContent>
    </Card>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function AccountingDashboardCharts({
  reportingBasis,
  fyStartMonth,
  currencyCode,
}: AccountingDashboardChartsProps) {
  return (
    <div className="space-y-4">
      <AccountingTrendChart
        reportingBasis={reportingBasis}
        fyStartMonth={fyStartMonth}
        currencyCode={currencyCode}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IncomeBreakdownChart
          reportingBasis={reportingBasis}
          fyStartMonth={fyStartMonth}
          currencyCode={currencyCode}
        />
        <ExpenseBreakdownChart
          reportingBasis={reportingBasis}
          fyStartMonth={fyStartMonth}
          currencyCode={currencyCode}
        />
      </div>
    </div>
  )
}
