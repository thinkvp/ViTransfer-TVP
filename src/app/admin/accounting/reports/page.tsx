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
import { BarChart2, Scale, Printer, FileText, Users } from 'lucide-react'
import type { ProfitLossReport, BalanceSheetReport, ProfitLossSection, BalanceSheetSection, AccountingSettings, TrialBalanceReport, TrialBalanceRow, AgedReceivablesReport, AgedReceivablesRow } from '@/lib/accounting/types'
import { cn } from '@/lib/utils'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `($${abs})` : `$${abs}`
}

export default function ReportsPage() {
  const [tab, setTab] = useState<'pl' | 'bs' | 'tb' | 'ar'>('pl')

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

  // Trial Balance state
  const [tbAsOf, setTbAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [tbReport, setTbReport] = useState<TrialBalanceReport | null>(null)
  const [tbLoading, setTbLoading] = useState(false)

  // Aged Receivables state
  const [arAsOf, setArAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [arReport, setArReport] = useState<AgedReceivablesReport | null>(null)
  const [arLoading, setArLoading] = useState(false)

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

  async function runTB() {
    setTbLoading(true)
    setTbReport(null)
    try {
      const res = await apiFetch(`/api/admin/accounting/reports/trial-balance?asOf=${tbAsOf}`)
      if (res.ok) { const d = await res.json(); setTbReport(d.report) }
    } finally { setTbLoading(false) }
  }

  async function runAR() {
    setArLoading(true)
    setArReport(null)
    try {
      const res = await apiFetch(`/api/admin/accounting/reports/aged-receivables?asOf=${arAsOf}`)
      if (res.ok) { const d = await res.json(); setArReport(d.report) }
    } finally { setArLoading(false) }
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
            } else if (tab === 'tb' && tbReport) {
              downloadCsv('trial-balance.csv', ['Code', 'Account', 'Type', 'Debit', 'Credit'],
                tbReport.rows.map(r => [r.code, r.name, r.type, (r.debitCents / 100).toFixed(2), (r.creditCents / 100).toFixed(2)])
                  .concat([['', 'TOTAL', '', (tbReport.totalDebitCents / 100).toFixed(2), (tbReport.totalCreditCents / 100).toFixed(2)]])
              )
            } else if (tab === 'ar' && arReport) {
              downloadCsv('aged-receivables.csv', ['Client', 'Invoice', 'Issue Date', 'Due Date', 'Total', 'Paid', 'Outstanding', 'Aging'],
                arReport.rows.map(r => [r.clientName, r.invoiceNumber, r.issueDate, r.dueDate ?? '', (r.totalCents / 100).toFixed(2), (r.paidCents / 100).toFixed(2), (r.outstandingCents / 100).toFixed(2), r.agingBucket === 'current' ? 'Current' : `${r.agingBucket}+ days`]))
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
            } else if (tab === 'tb' && tbReport) {
              const tbCols = [
                { header: 'Code', nowrap: true },
                { header: 'Account' },
                { header: 'Type', nowrap: true },
                { header: 'Debit', align: 'right' as const, nowrap: true },
                { header: 'Credit', align: 'right' as const, nowrap: true },
              ]
              const rows: PdfRow[] = tbReport.rows.map(r => ({
                cells: [r.code, r.name, r.type, r.debitCents > 0 ? fmtAud(r.debitCents) : '', r.creditCents > 0 ? fmtAud(r.creditCents) : ''],
              }))
              rows.push({ cells: ['', 'Total', '', fmtAud(tbReport.totalDebitCents), fmtAud(tbReport.totalCreditCents)], bold: true, doubleSeparator: true })
              generateReportPdf({ title: 'Trial Balance', subtitle: `As at ${tbReport.asAt}`, sections: [{ columns: tbCols, rows }] })
            } else if (tab === 'ar' && arReport) {
              const summarySection: PdfSection = {
                title: 'Summary',
                columns: [{ header: 'Aging Bucket' }, { header: 'Amount', align: 'right' as const, nowrap: true }],
                rows: [
                  { cells: ['Current', fmtAud(arReport.currentCents)] },
                  { cells: ['31–60 days', fmtAud(arReport.over30Cents)] },
                  { cells: ['61–90 days', fmtAud(arReport.over60Cents)] },
                  { cells: ['90+ days', fmtAud(arReport.over90Cents)] },
                  { cells: ['Total Outstanding', fmtAud(arReport.totalOutstandingCents)], bold: true, separator: true },
                ],
              }
              const detailCols = [
                { header: 'Client' },
                { header: 'Invoice', nowrap: true },
                { header: 'Issue Date', nowrap: true },
                { header: 'Due Date', nowrap: true },
                { header: 'Total', align: 'right' as const, nowrap: true },
                { header: 'Paid', align: 'right' as const, nowrap: true },
                { header: 'Outstanding', align: 'right' as const, nowrap: true },
                { header: 'Aging', nowrap: true },
              ]
              const detailRows: PdfRow[] = arReport.rows.map(r => ({
                cells: [r.clientName, r.invoiceNumber, r.issueDate, r.dueDate ?? '—', fmtAud(r.totalCents), fmtAud(r.paidCents), fmtAud(r.outstandingCents), r.agingBucket === 'current' ? 'Current' : `${r.agingBucket}+ days`],
              }))
              detailRows.push({ cells: ['', '', '', '', '', 'Total Outstanding', fmtAud(arReport.totalOutstandingCents), ''], bold: true, doubleSeparator: true })
              generateReportPdf({ title: 'Aged Receivables', subtitle: `As at ${arReport.asAt}`, sections: [summarySection, { title: 'Detail', columns: detailCols, rows: detailRows }] })
            }
          }}
          disabled={tab === 'pl' ? !plReport : tab === 'bs' ? !bsReport : tab === 'tb' ? !tbReport : !arReport}
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
        <Button variant={tab === 'tb' ? 'default' : 'outline'} onClick={() => setTab('tb')}>
          <FileText className="w-4 h-4 mr-1.5" />Trial Balance
        </Button>
        <Button variant={tab === 'ar' ? 'default' : 'outline'} onClick={() => setTab('ar')}>
          <Users className="w-4 h-4 mr-1.5" />Aged Receivables
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

      {/* Trial Balance */}
      {tab === 'tb' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label>As At</Label>
                  <Input type="date" value={tbAsOf} onChange={e => setTbAsOf(e.target.value)} className="h-9 w-36" />
                </div>
                <Button onClick={runTB} disabled={tbLoading || !tbAsOf} className="self-end">
                  {tbLoading ? 'Running…' : 'Run Report'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {tbReport && (
            <Card className="print:shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Trial Balance — As at {tbReport.asAt}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="border border-border rounded-md overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Code</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Account</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Debit</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tbReport.rows.map((r) => (
                        <tr key={r.accountId} className="border-b border-border last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
                          <td className="px-3 py-1.5">{r.name}</td>
                          <td className="px-3 py-1.5 text-muted-foreground text-xs">{r.type}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.debitCents > 0 ? fmtAud(r.debitCents) : ''}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.creditCents > 0 ? fmtAud(r.creditCents) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/40 font-bold">
                      <tr className="border-t-2 border-border">
                        <td className="px-3 py-2" colSpan={3}>Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtAud(tbReport.totalDebitCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtAud(tbReport.totalCreditCents)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {tbReport.totalDebitCents !== tbReport.totalCreditCents && (
                  <p className="mt-2 text-sm text-red-600 dark:text-red-400 font-medium">
                    ⚠ Debits and credits are not balanced (difference: {fmtAud(Math.abs(tbReport.totalDebitCents - tbReport.totalCreditCents))})
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Aged Receivables */}
      {tab === 'ar' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label>As At</Label>
                  <Input type="date" value={arAsOf} onChange={e => setArAsOf(e.target.value)} className="h-9 w-36" />
                </div>
                <Button onClick={runAR} disabled={arLoading || !arAsOf} className="self-end">
                  {arLoading ? 'Running…' : 'Run Report'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {arReport && (
            <Card className="print:shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Aged Receivables — As at {arReport.asAt}</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Summary buckets */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
                  {([
                    { label: 'Current', cents: arReport.currentCents },
                    { label: '31–60 days', cents: arReport.over30Cents },
                    { label: '61–90 days', cents: arReport.over60Cents },
                    { label: '90+ days', cents: arReport.over90Cents },
                    { label: 'Total', cents: arReport.totalOutstandingCents },
                  ] as const).map((b) => (
                    <div key={b.label} className="rounded-lg border border-border p-3 text-center">
                      <p className="text-xs text-muted-foreground">{b.label}</p>
                      <p className={cn('text-sm font-semibold tabular-nums mt-0.5', b.cents > 0 ? 'text-red-600 dark:text-red-400' : '')}>{fmtAud(b.cents)}</p>
                    </div>
                  ))}
                </div>

                {arReport.rows.length === 0 ? (
                  <p className="text-center text-muted-foreground py-6">No outstanding receivables.</p>
                ) : (
                  <div className="border border-border rounded-md overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Client</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Issue Date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Due Date</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Paid</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Outstanding</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Aging</th>
                        </tr>
                      </thead>
                      <tbody>
                        {arReport.rows.map((r) => (
                          <tr key={r.invoiceId} className="border-b border-border last:border-0 hover:bg-muted/30">
                            <td className="px-3 py-1.5">{r.clientName}</td>
                            <td className="px-3 py-1.5 font-mono text-xs">{r.invoiceNumber}</td>
                            <td className="px-3 py-1.5 text-xs tabular-nums">{r.issueDate}</td>
                            <td className="px-3 py-1.5 text-xs tabular-nums">{r.dueDate ?? '—'}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmtAud(r.totalCents)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmtAud(r.paidCents)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-medium text-red-600 dark:text-red-400">{fmtAud(r.outstandingCents)}</td>
                            <td className="px-3 py-1.5 text-center">
                              <span className={cn(
                                'inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium',
                                r.agingBucket === 'current' && 'bg-green-500/10 text-green-700 dark:text-green-400',
                                r.agingBucket === '30' && 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
                                r.agingBucket === '60' && 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
                                r.agingBucket === '90' && 'bg-red-500/10 text-red-700 dark:text-red-400',
                              )}>
                                {r.agingBucket === 'current' ? 'Current' : `${r.agingBucket}+ days`}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-muted/40 font-bold">
                        <tr className="border-t-2 border-border">
                          <td className="px-3 py-2" colSpan={6}>Total Outstanding</td>
                          <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{fmtAud(arReport.totalOutstandingCents)}</td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
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
