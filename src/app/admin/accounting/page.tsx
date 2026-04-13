'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'
import { AlertTriangle, TrendingUp, TrendingDown, Landmark, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountingSettings } from '@/lib/accounting/types'

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

interface DashboardStats {
  unmatchedCount: number
  draftExpenseCount: number
  bankAccounts: { id: string; name: string; currentBalance: number; pendingTransactionAmount: number }[]
  pl: { totalIncomeCents: number; totalExpenseCents: number; netProfitCents: number } | null
  reportingBasis: 'CASH' | 'ACCRUAL'
}

export default function AccountingDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const fy = getCurrentFY()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [txnRes, expRes, bankRes, plRes] = await Promise.all([
        apiFetch('/api/admin/accounting/transactions?status=UNMATCHED&pageSize=1'),
        apiFetch('/api/admin/accounting/expenses?status=DRAFT&pageSize=1'),
        apiFetch('/api/admin/accounting/bank-accounts'),
        apiFetch('/api/admin/accounting/settings'),
      ])
      const txnData = txnRes.ok ? await txnRes.json() : null
      const expData = expRes.ok ? await expRes.json() : null
      const bankData = bankRes.ok ? await bankRes.json() : null
      const settingsData: AccountingSettings | null = plRes.ok ? await plRes.json() : null
      const reportingBasis = settingsData?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL'
      const reportRes = await apiFetch(`/api/admin/accounting/reports/profit-loss?from=${fy.from}&to=${fy.to}&basis=${reportingBasis}`)
      const plData = reportRes.ok ? await reportRes.json() : null

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
          <Card className={cn('hover:bg-accent/30 transition-colors', (stats?.unmatchedCount ?? 0) > 0 && 'border-amber-400/40')}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />Unmatched Transactions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn('text-3xl font-bold', (stats?.unmatchedCount ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
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
                <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-400">{fmtAud(stats.pl.totalIncomeCents)}</p>
                <p className="text-xs text-muted-foreground mt-1">{stats.reportingBasis === 'CASH' ? 'cash basis, ex GST' : 'accrual basis, ex GST'}</p>
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
                  <p className={cn('text-3xl font-bold', stats.pl.netProfitCents >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>
                    {fmtAud(stats.pl.netProfitCents)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">income minus expenses</p>
                </CardContent>
              </Card>
            </Link>
          </>
        )}
      </div>

      {/* Bank accounts */}
      {(stats?.bankAccounts?.length ?? 0) > 0 && (
        <div>
          <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
            <Landmark className="w-4 h-4" />Bank Accounts
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {stats!.bankAccounts.map(a => (
              <Link key={a.id} href="/admin/accounting/bank-accounts">
                <Card className="hover:bg-accent/30 transition-colors">
                  <CardContent className="py-3 px-4">
                    <p className="font-medium text-sm">{a.name}</p>
                    <p className="text-sm font-medium mt-1">Current balance: {fmtAud(a.currentBalance)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Pending transactions: {fmtAud(a.pendingTransactionAmount)}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
