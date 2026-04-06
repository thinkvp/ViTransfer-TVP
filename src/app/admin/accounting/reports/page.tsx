'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DateRangePreset } from '@/components/admin/accounting/DateRangePreset'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'
import { apiFetch } from '@/lib/api-client'
import { BarChart2, Scale, Printer } from 'lucide-react'
import type { ProfitLossReport, BalanceSheetReport, ProfitLossSection, BalanceSheetSection } from '@/lib/accounting/types'
import { cn } from '@/lib/utils'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `($${abs})` : `$${abs}`
}

// Default to current FY (July → June)
function defaultFyDates() {
  const now = new Date()
  const m = now.getMonth() + 1 // 1-12
  const y = now.getFullYear()
  if (m >= 7) return { from: `${y}-07-01`, to: `${y + 1}-06-30` }
  return { from: `${y - 1}-07-01`, to: `${y}-06-30` }
}

export default function ReportsPage() {
  const [tab, setTab] = useState<'pl' | 'bs'>('pl')

  // P&L state
  const { from: defFrom, to: defTo } = defaultFyDates()
  const [plFrom, setPlFrom] = useState(defFrom)
  const [plTo, setPlTo] = useState(defTo)
  const [plBasis, setPlBasis] = useState<'ACCRUAL' | 'CASH'>('ACCRUAL')
  const [plReport, setPlReport] = useState<ProfitLossReport | null>(null)
  const [plLoading, setPlLoading] = useState(false)

  // Balance Sheet state
  const [bsAsOf, setBsAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [bsReport, setBsReport] = useState<BalanceSheetReport | null>(null)
  const [bsLoading, setBsLoading] = useState(false)

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
              plReport.income.forEach(l => rows.push(['', l.accountName, (l.amountCents / 100).toFixed(2)]))
              rows.push(['Total Income', '', (plReport.totalIncomeCents / 100).toFixed(2)])
              if (plReport.cogs.length) {
                rows.push(['COGS', '', ''])
                plReport.cogs.forEach(l => rows.push(['', l.accountName, (l.amountCents / 100).toFixed(2)]))
              }
              rows.push(['Gross Profit', '', (plReport.grossProfitCents / 100).toFixed(2)])
              rows.push(['EXPENSES', '', ''])
              plReport.expenses.forEach(l => rows.push(['', l.accountName, (l.amountCents / 100).toFixed(2)]))
              rows.push(['Net Profit', '', (plReport.netProfitCents / 100).toFixed(2)])
              downloadCsv('profit-and-loss.csv', ['Section', 'Account', 'Amount'], rows)
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
          onExportPdf={() => downloadPdf(tab === 'pl' ? 'Profit & Loss' : 'Balance Sheet')}
          disabled={tab === 'pl' ? !plReport : !bsReport}
        />
      </div>

      {/* Tab toggles */}
      <div className="flex gap-2">
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
                  <Select value={plBasis} onValueChange={v => setPlBasis(v as 'ACCRUAL' | 'CASH')}>
                    <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACCRUAL">Accrual</SelectItem>
                      <SelectItem value="CASH">Cash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={runPL} disabled={plLoading || !plFrom || !plTo} className="self-end">
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
                <PLSection title="Income" rows={plReport.income} total={plReport.totalIncomeCents} totalLabel="Total Income" positive />
                {plReport.cogs.length > 0 && (
                  <PLSection title="Cost of Goods Sold" rows={plReport.cogs} />
                )}
                <div className="flex justify-between py-1.5 font-semibold text-sm border-t border-border mt-2">
                  <span>Gross Profit</span>
                  <span className={plReport.grossProfitCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                    {fmtAud(plReport.grossProfitCents)}
                  </span>
                </div>
                <PLSection title="Expenses" rows={plReport.expenses} />
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

function PLSection({ title, rows, total, totalLabel, positive }: {
  title: string
  rows: import('@/lib/accounting/types').ProfitLossSection[]
  total?: number
  totalLabel?: string
  positive?: boolean
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      {rows.map((row, i) => (
        <div key={i} className={cn('flex justify-between py-0.5 text-sm', row.isSubtotal && 'font-semibold border-t border-border mt-1')}>
          <span className={row.isSubtotal ? '' : 'text-muted-foreground pl-2'}>{row.accountCode ? `${row.accountCode} — ` : ''}{row.accountName}</span>
          <span className="tabular-nums">{fmtAud(row.amountCents)}</span>
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
