'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'
import { AlertTriangle, TrendingUp, TrendingDown, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountingSettings } from '@/lib/accounting/types'
import { AccountingDashboardCharts } from '@/components/admin/accounting/AccountingDashboardCharts'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-$${abs}` : `$${abs}`
}

function getCurrentFY(): { from: string; to: string; label: string } {
  const now = new Date()
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
  return {
    from: `${year}-07-01`,
    to: `${year + 1}-06-30`,
    label: `FY${String(year).slice(2)}/${String(year + 1).slice(2)}`,
  }
}

// Same-elapsed-point window in the previous FY (1 Jul last year → this date one year
// ago), so mid-year deltas compare like-for-like rather than against a full prior FY.
function getPriorFYToDate(): { from: string; to: string; label: string } {
  const now = new Date()
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
  const prevPoint = new Date(now)
  prevPoint.setFullYear(prevPoint.getFullYear() - 1)
  const to = `${prevPoint.getFullYear()}-${String(prevPoint.getMonth() + 1).padStart(2, '0')}-${String(prevPoint.getDate()).padStart(2, '0')}`
  return {
    from: `${year - 1}-07-01`,
    to,
    label: `FY${String(year - 1).slice(2)}/${String(year).slice(2)}`,
  }
}

function DeltaLine({ currentCents, priorCents, priorLabel }: { currentCents: number; priorCents: number | null; priorLabel: string }) {
  if (priorCents === null || (priorCents === 0 && currentCents === 0)) return null
  const diff = currentCents - priorCents
  const up = diff >= 0
  // Percent change is only meaningful against a positive prior figure (e.g. a
  // prior-year net loss); otherwise fall back to the absolute movement.
  const usePct = priorCents > 0
  return (
    <p className="text-xs text-muted-foreground mt-1">
      <span className={up ? 'text-emerald-400' : 'text-destructive'}>
        {up ? '▲' : '▼'} {usePct ? `${Math.abs(Math.round((diff / priorCents) * 100))}%` : fmtAud(Math.abs(diff))}
      </span>{' '}
      vs {priorLabel} same point
    </p>
  )
}

function computeProjectedNetProfit(netProfitCents: number, fyStartMonth: number): number | null {
  const now = new Date()
  const fyStartM = Math.max(1, Math.min(12, fyStartMonth)) - 1 // 0-indexed
  const fyStartYear = now.getMonth() >= fyStartM ? now.getFullYear() : now.getFullYear() - 1
  const fyStart = new Date(fyStartYear, fyStartM, 1)
  const monthCount =
    (now.getFullYear() - fyStart.getFullYear()) * 12 +
    (now.getMonth() - fyStart.getMonth()) + 1
  const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const currentMonthFraction = now.getDate() / daysInCurrentMonth
  const elapsedMonths = Math.max(monthCount - 1 + currentMonthFraction, currentMonthFraction)
  if (elapsedMonths <= 0) return null
  return Math.round(netProfitCents / elapsedMonths) * 12
}

interface DashboardStats {
  unmatchedCount: number
  draftExpenseCount: number
  bankAccounts: { id: string; name: string; currentBalance: number; pendingTransactionAmount: number }[]
  pl: { totalIncomeCents: number; totalExpenseCents: number; netProfitCents: number } | null
  priorPl: { totalIncomeCents: number; netProfitCents: number } | null
  reportingBasis: 'CASH' | 'ACCRUAL'
}

interface ChartSettings {
  fyStartMonth: number
  currencyCode: string
}

export default function AccountingDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [chartSettings, setChartSettings] = useState<ChartSettings>({ fyStartMonth: 7, currencyCode: 'AUD' })
  const [loading, setLoading] = useState(true)
  const fy = getCurrentFY()
  const priorFyLabel = getPriorFYToDate().label

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [txnRes, expRes, bankRes, plRes, salesSettingsRes] = await Promise.all([
        apiFetch('/api/admin/accounting/transactions?status=UNMATCHED&pageSize=1'),
        apiFetch('/api/admin/accounting/expenses?status=DRAFT&pageSize=1'),
        apiFetch('/api/admin/accounting/bank-accounts'),
        apiFetch('/api/admin/accounting/settings'),
        apiFetch('/api/admin/sales/settings'),
      ])
      const txnData = txnRes.ok ? await txnRes.json() : null
      const expData = expRes.ok ? await expRes.json() : null
      const bankData = bankRes.ok ? await bankRes.json() : null
      const settingsData: AccountingSettings | null = plRes.ok ? await plRes.json() : null
      const salesSettings = salesSettingsRes.ok ? await salesSettingsRes.json() : null
      const reportingBasis = settingsData?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL'
      const priorFy = getPriorFYToDate()
      const [reportRes, priorReportRes] = await Promise.all([
        apiFetch(`/api/admin/accounting/reports/profit-loss?from=${fy.from}&to=${fy.to}&basis=${reportingBasis}`),
        apiFetch(`/api/admin/accounting/reports/profit-loss?from=${priorFy.from}&to=${priorFy.to}&basis=${reportingBasis}`),
      ])
      const plData = reportRes.ok ? await reportRes.json() : null
      const priorPlData = priorReportRes.ok ? await priorReportRes.json() : null

      setChartSettings({
        fyStartMonth: salesSettings?.fiscalYearStartMonth ?? 7,
        currencyCode: salesSettings?.currencyCode ?? 'AUD',
      })
      setStats({
        unmatchedCount: txnData?.total ?? 0,
        draftExpenseCount: expData?.pagination?.total ?? expData?.total ?? 0,
        bankAccounts: (bankData?.bankAccounts ?? []).slice(0, 6),
        reportingBasis,
        pl: plData?.report
          ? {
              totalIncomeCents: plData.report.totalIncomeCents ?? 0,
              totalExpenseCents: plData.report.totalExpenseCents ?? 0,
              netProfitCents: plData.report.netProfitCents ?? 0,
            }
          : null,
        priorPl: priorPlData?.report
          ? {
              totalIncomeCents: priorPlData.report.totalIncomeCents ?? 0,
              netProfitCents: priorPlData.report.netProfitCents ?? 0,
            }
          : null,
      })
    } finally { setLoading(false) }
  }, [fy.from, fy.to])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="py-16 text-center text-muted-foreground text-sm">Loading dashboard…</div>
  }

  return (
    <div className="space-y-6">
      {/* Action items */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/admin/accounting/bank-accounts">
          <Card className={cn('hover:bg-accent/30 transition-colors', (stats?.unmatchedCount ?? 0) > 0 && 'border-warning/40')}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-warning" />Unmatched Transactions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn('text-3xl font-bold', (stats?.unmatchedCount ?? 0) > 0 ? 'text-warning' : 'text-muted-foreground')}>
                {stats?.unmatchedCount ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">pending reconciliation</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/accounting/expenses">
          <Card className="hover:bg-accent/30 transition-colors">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Receipt className="w-4 h-4" />Draft Expenses
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{stats?.draftExpenseCount ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-1">awaiting approval</p>
            </CardContent>
          </Card>
        </Link>

        {stats?.pl && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-500" />Income ({fy.label})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-emerald-400">{fmtAud(stats.pl.totalIncomeCents)}</p>
                <p className="text-xs text-muted-foreground mt-1">{stats.reportingBasis === 'CASH' ? 'cash basis, ex GST' : 'accrual basis, ex GST'}</p>
                <DeltaLine
                  currentCents={stats.pl.totalIncomeCents}
                  priorCents={stats.priorPl?.totalIncomeCents ?? null}
                  priorLabel={priorFyLabel}
                />
              </CardContent>
            </Card>

            <Link href="/admin/accounting/reports">
              <Card className="hover:bg-accent/30 transition-colors">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    {stats.pl.netProfitCents >= 0
                      ? <TrendingUp className="w-4 h-4 text-emerald-500" />
                      : <TrendingDown className="w-4 h-4 text-destructive" />}
                    Net Profit ({fy.label})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className={cn('text-3xl font-bold', stats.pl.netProfitCents >= 0 ? 'text-emerald-400' : 'text-destructive')}>
                    {fmtAud(stats.pl.netProfitCents)}
                  </p>
                  {(() => {
                    const proj = computeProjectedNetProfit(stats.pl.netProfitCents, chartSettings.fyStartMonth)
                    return proj !== null ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        Projected {fy.label}:{' '}
                        <span className={proj >= 0 ? 'text-emerald-400' : 'text-destructive'}>
                          {fmtAud(proj)}
                        </span>
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">income minus expenses</p>
                    )
                  })()}
                  <DeltaLine
                    currentCents={stats.pl.netProfitCents}
                    priorCents={stats.priorPl?.netProfitCents ?? null}
                    priorLabel={priorFyLabel}
                  />
                </CardContent>
              </Card>
            </Link>
          </>
        )}
      </div>

      {/* Charts */}
      {stats && (
        <AccountingDashboardCharts
          reportingBasis={stats.reportingBasis}
          fyStartMonth={chartSettings.fyStartMonth}
          currencyCode={chartSettings.currencyCode}
        />
      )}


    </div>
  )
}
