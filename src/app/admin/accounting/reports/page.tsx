'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import type { PdfSection, PdfRow } from '@/components/admin/accounting/ExportMenu'
import { apiFetch } from '@/lib/api-client'
import Link from 'next/link'
import { BarChart2, Scale } from 'lucide-react'
import type { ProfitLossReport, BalanceSheetReport, ProfitLossSection, BalanceSheetSection, AccountingSettings } from '@/lib/accounting/types'
import { cn } from '@/lib/utils'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `($${abs})` : `$${abs}`
}

export default function ReportsPage() {
  const [tab, setTab] = useState<'pl' | 'bs'>('pl')

  // P&L state
  const { from: defFrom, to: defTo } = getThisFinancialYearDates()
  const [plFrom, setPlFrom] = useState(defFrom)
  const [plTo, setPlTo] = useState(defTo)
  const [plBasis, setPlBasis] = useState<'ACCRUAL' | 'CASH'>('ACCRUAL')
  const [plReport, setPlReport] = useState<ProfitLossReport | null>(null)
  const [plLoading, setPlLoading] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(true)

  // Balance Sheet state
  const [bsAsOf, setBsAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [bsReport, setBsReport] = useState<BalanceSheetReport | null>(null)
  const [bsLoading, setBsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const res = await apiFetch('/api/admin/accounting/settings')
        const data: AccountingSettings | null = res.ok ? await res.json() : null
        if (!cancelled) setPlBasis(data?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL')
      } finally {
        if (!cancelled) setSettingsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  async function runPL() {
    setPlLoading(true)
    setPlReport(null)
    try {
      const params = new URLSearchParams({ from: plFrom, to: plTo, basis: plBasis })
      const res = await apiFetch(`/api/admin/accounting/reports/profit-loss?${params}`)
      if (res.ok) { const d = await res.json(); setPlReport(d.report) }
    } finally { setPlLoading(false) }
  }

  async function runBS() {
    setBsLoading(true)
    setBsReport(null)
    try {
      const res = await apiFetch(`/api/admin/accounting/reports/balance-sheet?asOf=${bsAsOf}`)
      if (res.ok) { const d = await res.json(); setBsReport(d.report) }
    } finally { setBsLoading(false) }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Reports</h2>
          <p className="text-sm text-muted-foreground">Financial reports for your business.</p>
        </div>
        <ExportMenu
          onExportCsv={() => {
            if (tab === 'pl' && plReport) {
              const rows: string[][] = []
              rows.push(['INCOME', '', ''])
              plReport.income.forEach(l => rows.push(['', l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, l.hideAmount ? '' : (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Income', '', (plReport.totalIncomeCents / 100).toFixed(2)])
              if (plReport.cogs.length) {
                rows.push(['COGS', '', ''])
                plReport.cogs.forEach(l => rows.push(['', l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, l.hideAmount ? '' : (l.amountCents / 100).toFixed(2)]))
                rows.push(['Total Cost of Goods Sold', '', (plReport.totalCogsCents / 100).toFixed(2)])
              }
              rows.push(['Gross Profit', '', (plReport.grossProfitCents / 100).toFixed(2)])
              rows.push(['EXPENSES', '', ''])
              plReport.expenses.forEach(l => rows.push(['', l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, l.hideAmount ? '' : (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Expenses', '', (plReport.totalExpenseCents / 100).toFixed(2)])
              rows.push(['Net Profit', '', (plReport.netProfitCents / 100).toFixed(2)])
              downloadCsv('profit-and-loss.csv', ['Section', 'Account', 'Amount (ex GST)'], rows)
            } else if (tab === 'bs' && bsReport) {
              const rows: string[][] = []
              rows.push(['ASSETS', '', ''])
              bsReport.assets.forEach(l => rows.push(['', l.label, (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Assets', '', (bsReport.totalAssetsCents / 100).toFixed(2)])
              rows.push(['LIABILITIES', '', ''])
              bsReport.liabilities.forEach(l => rows.push(['', l.label, (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Liabilities', '', (bsReport.totalLiabilitiesCents / 100).toFixed(2)])
              rows.push(['EQUITY', '', ''])
              bsReport.equity.forEach(l => rows.push(['', l.label, (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Equity', '', (bsReport.totalEquityCents / 100).toFixed(2)])
              downloadCsv('balance-sheet.csv', ['Section', 'Account', 'Amount'], rows)
            }
          }}
          onExportPdf={() => {
            if (tab === 'pl' && plReport) {
              const plCols = [{ header: 'Account' }, { header: 'Amount (ex GST)', align: 'right' as const, nowrap: true }]
              const sections: PdfSection[] = []
              // Income
              const incomeRows: PdfRow[] = plReport.income.filter(l => !l.hideAmount).map(l => ({
                cells: [l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, fmtAud(l.amountCents)],
                indent: !!l.depth,
              }))
              incomeRows.push({ cells: ['Total Income', fmtAud(plReport.totalIncomeCents)], bold: true, separator: true })
              sections.push({ title: 'Income', columns: plCols, rows: incomeRows })
              // COGS
              if (plReport.cogs.length > 0) {
                const cogsRows: PdfRow[] = plReport.cogs.filter(l => !l.hideAmount).map(l => ({
                  cells: [l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, fmtAud(l.amountCents)],
                  indent: !!l.depth,
                }))
                cogsRows.push({ cells: ['Total Cost of Goods Sold', fmtAud(plReport.totalCogsCents)], bold: true, separator: true })
                sections.push({ title: 'Cost of Goods Sold', columns: plCols, rows: cogsRows })
              }
              // Gross Profit
              sections.push({ columns: plCols, rows: [{ cells: ['Gross Profit', fmtAud(plReport.grossProfitCents)], bold: true, doubleSeparator: true, color: plReport.grossProfitCents >= 0 ? 'green' : 'red' }] })
              // Expenses
              const expRows: PdfRow[] = plReport.expenses.filter(l => !l.hideAmount).map(l => ({
                cells: [l.accountCode ? `${l.accountCode} — ${l.accountName}` : l.accountName, fmtAud(l.amountCents)],
                indent: !!l.depth,
              }))
              expRows.push({ cells: ['Total Expenses', fmtAud(plReport.totalExpenseCents)], bold: true, separator: true })
              sections.push({ title: 'Expenses', columns: plCols, rows: expRows })
              // Net Profit
              sections.push({ columns: plCols, rows: [{ cells: ['Net Profit', fmtAud(plReport.netProfitCents)], bold: true, doubleSeparator: true, color: plReport.netProfitCents >= 0 ? 'green' : 'red' }] })
              generateReportPdf({ title: 'Profit & Loss', subtitle: `${plReport.fromDate} to ${plReport.toDate} (${plReport.basis}) — All figures ex GST`, sections })
            } else if (tab === 'bs' && bsReport) {
              const bsCols = [{ header: 'Account' }, { header: 'Amount', align: 'right' as const, nowrap: true }]
              const mkSection = (title: string, rows: typeof bsReport.assets, total: number, totalLabel: string): PdfSection => ({
                title,
                columns: bsCols,
                rows: [
                  ...rows.map(r => ({ cells: [r.accountCode ? `${r.accountCode} — ${r.label}` : r.label, fmtAud(r.amountCents)] })),
                  { cells: [totalLabel, fmtAud(total)], bold: true, separator: true },
                ],
              })
              const sections: PdfSection[] = [
                mkSection('Assets', bsReport.assets, bsReport.totalAssetsCents, 'Total Assets'),
                mkSection('Liabilities', bsReport.liabilities, bsReport.totalLiabilitiesCents, 'Total Liabilities'),
                mkSection('Equity', bsReport.equity, bsReport.totalEquityCents, 'Total Equity'),
                { columns: bsCols, rows: [{ cells: ['Net Assets', fmtAud(bsReport.totalAssetsCents - bsReport.totalLiabilitiesCents)], bold: true, doubleSeparator: true }] },
              ]
              generateReportPdf({ title: 'Balance Sheet', subtitle: `As at ${bsReport.asAt}`, sections })
            }
          }}
          disabled={tab === 'pl' ? !plReport : !bsReport}
        />
      </div>

      {/* Tab toggles */}
      <div className="flex gap-2 flex-wrap">
        <Button variant={tab === 'pl' ? 'default' : 'outline'} onClick={() => setTab('pl')}>
          <BarChart2 className="w-4 h-4 mr-1.5" />Profit &amp; Loss
        </Button>
        <Button variant={tab === 'bs' ? 'default' : 'outline'} onClick={() => setTab('bs')}>
          <Scale className="w-4 h-4 mr-1.5" />Balance Sheet
        </Button>
      </div>

      {/* P&L */}
      {tab === 'pl' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <DateRangePreset
                  from={plFrom}
                  to={plTo}
                  onFromChange={setPlFrom}
                  onToChange={setPlTo}
                />
                <div className="space-y-1">
                  <Label>Basis</Label>
                  <div className="h-9 min-w-32 rounded-md border border-input bg-muted/30 px-3 flex items-center text-sm text-muted-foreground">
                    {plBasis === 'CASH' ? 'Cash' : 'Accrual'}
                  </div>
                </div>
                <Button onClick={runPL} disabled={settingsLoading || plLoading || !plFrom || !plTo} className="self-end">
                  {plLoading ? 'Running…' : 'Run Report'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {plReport && (
            <Card className="print:shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Profit &amp; Loss — {plReport.fromDate} to {plReport.toDate}
                  <span className="text-sm font-normal text-muted-foreground ml-2">({plReport.basis})</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">All figures shown ex GST.</p>
                <PLSection title="Income" rows={plReport.income} total={plReport.totalIncomeCents} totalLabel="Total Income" positive from={plFrom} to={plTo} />
                {plReport.cogs.length > 0 && (
                  <PLSection title="Cost of Goods Sold" rows={plReport.cogs} total={plReport.totalCogsCents} totalLabel="Total Cost of Goods Sold" from={plFrom} to={plTo} />
                )}
                <div className="flex justify-between py-1.5 font-semibold text-sm border-t border-border mt-2">
                  <span>Gross Profit</span>
                  <span className={plReport.grossProfitCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                    {fmtAud(plReport.grossProfitCents)}
                  </span>
                </div>
                <PLSection title="Expenses" rows={plReport.expenses} total={plReport.totalExpenseCents} totalLabel="Total Expenses" from={plFrom} to={plTo} />
                <div className="flex justify-between py-2 font-bold text-sm border-t-2 border-border mt-2">
                  <span>Net Profit</span>
                  <span className={plReport.netProfitCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                    {fmtAud(plReport.netProfitCents)}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Balance Sheet */}
      {tab === 'bs' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label>As At</Label>
                  <Input type="date" value={bsAsOf} onChange={e => setBsAsOf(e.target.value)} className="h-9 w-36" />
                </div>
                <Button onClick={runBS} disabled={bsLoading || !bsAsOf} className="self-end">
                  {bsLoading ? 'Running…' : 'Run Report'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {bsReport && (
            <Card className="print:shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Balance Sheet — As at {bsReport.asAt}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <BSSection title="Assets" rows={bsReport.assets} total={bsReport.totalAssetsCents} totalLabel="Total Assets" />
                <BSSection title="Liabilities" rows={bsReport.liabilities} total={bsReport.totalLiabilitiesCents} totalLabel="Total Liabilities" />
                <BSSection title="Equity" rows={bsReport.equity} total={bsReport.totalEquityCents} totalLabel="Total Equity" />
                <div className="flex justify-between py-2 font-bold text-sm border-t-2 border-border">
                  <span>Net Assets</span>
                  <span>{fmtAud(bsReport.totalAssetsCents - bsReport.totalLiabilitiesCents)}</span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

    </div>
  )
}

function PLSection({ title, rows, total, totalLabel, positive, from, to }: {
  title: string
  rows: import('@/lib/accounting/types').ProfitLossSection[]
  total?: number
  totalLabel?: string
  positive?: boolean
  from?: string
  to?: string
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      {rows.map((row, i) => (
        <div key={i} className={cn(
          'flex justify-between py-0.5 text-sm',
          row.isSubtotal && 'font-semibold border-t border-border mt-1',
        )}>
          <span className={cn(!row.isSubtotal && 'text-muted-foreground', row.depth ? 'pl-6' : 'pl-2')}>
            {row.accountCode ? `${row.accountCode} — ` : ''}{row.accountName}
          </span>
          {row.hideAmount ? <span /> : (
            row.accountCode && from && to
              ? (
                <Link
                  href={`/admin/accounting/chart-of-accounts/${row.accountCode}?from=${from}&to=${to}`}
                  className="tabular-nums hover:underline underline-offset-2"
                >
                  {fmtAud(row.amountCents)}
                </Link>
              )
              : <span className="tabular-nums">{fmtAud(row.amountCents)}</span>
          )}
        </div>
      ))}
      {total != null && (
        <div className="flex justify-between py-1 font-semibold text-sm border-t border-border">
          <span>{totalLabel}</span>
          <span className={cn('tabular-nums', positive && total >= 0 ? 'text-green-600 dark:text-green-400' : '')}>{fmtAud(total)}</span>
        </div>
      )}
    </div>
  )
}

function BSSection({ title, rows, total, totalLabel }: {
  title: string
  rows: import('@/lib/accounting/types').BalanceSheetSection[]
  total: number
  totalLabel: string
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      {rows.map((row, i) => (
        <div key={i} className="flex justify-between py-0.5 text-sm">
          <span className="text-muted-foreground pl-2">{row.accountCode ? `${row.accountCode} — ` : ''}{row.label}</span>
          <span className="tabular-nums">{fmtAud(row.amountCents)}</span>
        </div>
      ))}
      <div className="flex justify-between py-1 font-semibold text-sm border-t border-border">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{fmtAud(total)}</span>
      </div>
    </div>
  )
}
