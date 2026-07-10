'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, ReceiptText, CheckCircle2, XCircle, AlertTriangle, Paperclip } from 'lucide-react'
import { apiFetch, apiPost } from '@/lib/api-client'
import type { ResolvedExpenseProposal } from '@/lib/ai/expense-schemas'
import { base64ToFile, type AssistantAttachment, type CreateStep } from './helpers'

const TAX_CODES = [
  { value: 'GST', label: 'GST' },
  { value: 'GST_FREE', label: 'GST-free' },
  { value: 'BAS_EXCLUDED', label: 'BAS excluded' },
  { value: 'INPUT_TAXED', label: 'Input taxed' },
] as const

interface AccountOption {
  id: string
  code: string
  name: string
  type: string
}

interface ExpenseRow {
  proposal: ResolvedExpenseProposal
  date: string
  supplierName: string
  description: string
  amount: string // dollars, editable text
  taxCode: string
  accountId: string
  steps: CreateStep[]
  creating: boolean
  createdExpenseId: string | null
  error: string
}

interface ExpenseProposalCardProps {
  proposals: ResolvedExpenseProposal[]
  /** Original files from the assistant form — the receipt is attached to the created expense */
  attachments: AssistantAttachment[]
}

function rowFromProposal(p: ResolvedExpenseProposal): ExpenseRow {
  return {
    proposal: p,
    date: p.date,
    supplierName: p.supplierName ?? '',
    description: p.description,
    amount: p.amountIncGst.toFixed(2),
    taxCode: p.taxCode,
    accountId: p.accountId ?? '',
    steps: [],
    creating: false,
    createdExpenseId: null,
    error: '',
  }
}

function rowValidationError(row: ExpenseRow): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return 'Pick a valid date'
  const amount = Number.parseFloat(row.amount)
  if (!Number.isFinite(amount) || amount <= 0) return 'Amount must be greater than 0'
  if (!row.accountId) return 'Pick an account'
  if (!row.description.trim()) return 'Description is required'
  return null
}

export function ExpenseProposalCard({ proposals, attachments }: ExpenseProposalCardProps) {
  const [rows, setRows] = useState<ExpenseRow[]>(() => proposals.map(rowFromProposal))
  const [accounts, setAccounts] = useState<AccountOption[]>([])

  // Re-key rows when a refine turn replaces the proposals
  useEffect(() => {
    setRows(proposals.map(rowFromProposal))
  }, [proposals])

  useEffect(() => {
    apiFetch('/api/admin/accounting/accounts?expenseTypes=true&activeOnly=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.accounts) setAccounts(d.accounts)
      })
      .catch(() => {})
  }, [])

  const updateRow = (index: number, patch: Partial<ExpenseRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  async function createExpense(index: number) {
    const row = rows[index]
    if (!row || row.creating || row.createdExpenseId) return

    const validationError = rowValidationError(row)
    if (validationError) {
      updateRow(index, { error: validationError })
      return
    }

    // Local mutable step list — same pattern as ProjectProposalCard
    const localSteps: CreateStep[] = []
    const pushStep = (label: string): number => {
      localSteps.push({ label, state: 'running' })
      updateRow(index, { steps: [...localSteps] })
      return localSteps.length - 1
    }
    const settleStep = (i: number, state: CreateStep['state'], detail?: string) => {
      localSteps[i] = { ...localSteps[i], state, detail }
      updateRow(index, { steps: [...localSteps] })
    }

    updateRow(index, { creating: true, error: '', steps: [] })
    try {
      const label = row.supplierName.trim() || row.description.trim()
      const createStep = pushStep(`Create expense "${label}"`)
      let expenseId: string
      try {
        const res = await apiPost<{ expense: { id: string } }>('/api/admin/accounting/expenses', {
          date: row.date,
          supplierName: row.supplierName.trim() || null,
          description: row.description.trim(),
          accountId: row.accountId,
          taxCode: row.taxCode,
          amountIncGst: Number.parseFloat(row.amount),
        })
        expenseId = res.expense?.id ?? (res as unknown as { id?: string }).id ?? ''
        if (!expenseId) throw new Error('Expense was not created')
        settleStep(createStep, 'done')
      } catch (e) {
        settleStep(createStep, 'failed', e instanceof Error ? e.message : 'Failed')
        throw e
      }

      // Attach the receipt from browser memory. Non-fatal: the expense exists either way.
      const receipt = attachments[row.proposal.attachmentIndex]
      if (receipt) {
        const step = pushStep(`Attach receipt "${receipt.fileName}"`)
        try {
          const formData = new FormData()
          formData.append('file', base64ToFile(receipt))
          const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}/attachments`, {
            method: 'POST',
            body: formData,
          })
          if (!res.ok) {
            const d = await res.json().catch(() => ({}))
            throw new Error(d.error || `Upload failed (${res.status})`)
          }
          settleStep(step, 'done')
        } catch (e) {
          settleStep(step, 'failed', e instanceof Error ? e.message : 'Failed')
        }
      } else {
        const step = pushStep('Attach receipt')
        settleStep(step, 'skipped', 'Receipt not held in this session — upload it on the expense')
      }

      updateRow(index, { createdExpenseId: expenseId })
    } catch (e) {
      updateRow(index, { error: e instanceof Error ? e.message : 'Expense creation failed' })
    } finally {
      updateRow(index, { creating: false })
    }
  }

  async function createAll() {
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].createdExpenseId) {
        // Sequential on purpose — steps render per row and the API is rate-limited
        await createExpense(i)
      }
    }
  }

  const pendingRows = rows.filter((r) => !r.createdExpenseId)
  const anyCreating = rows.some((r) => r.creating)

  return (
    <Card className="border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <ReceiptText className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <CardTitle>
              Expense proposal{rows.length === 1 ? '' : `s (${rows.length})`}
            </CardTitle>
            <CardDescription>Review and edit before creating — expenses are created as drafts.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No expenses were extracted from the attached receipts.</p>
        )}

        {rows.map((row, index) => {
          const disabled = row.creating || row.createdExpenseId != null
          const receipt = attachments[row.proposal.attachmentIndex]
          return (
            <div key={index} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {receipt && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-0.5">
                    <Paperclip className="w-3 h-3" />
                    <span className="max-w-40 truncate">{receipt.fileName}</span>
                  </span>
                )}
                <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 capitalize text-muted-foreground">
                  {row.proposal.confidence} confidence
                </span>
                {row.createdExpenseId && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-green-600/40 bg-green-600/10 px-2 py-0.5 text-green-600">
                    <CheckCircle2 className="w-3 h-3" /> Created
                  </span>
                )}
              </div>

              {row.proposal.possibleDuplicate && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    Possible duplicate: an expense dated {row.proposal.possibleDuplicate.date} for $
                    {row.proposal.possibleDuplicate.amountIncGst.toFixed(2)} already exists (&ldquo;
                    {row.proposal.possibleDuplicate.description}&rdquo;).
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor={`ai-expense-supplier-${index}`}>Supplier</Label>
                  <Input
                    id={`ai-expense-supplier-${index}`}
                    value={row.supplierName}
                    disabled={disabled}
                    onChange={(e) => updateRow(index, { supplierName: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`ai-expense-description-${index}`}>Description</Label>
                  <Input
                    id={`ai-expense-description-${index}`}
                    value={row.description}
                    disabled={disabled}
                    onChange={(e) => updateRow(index, { description: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`ai-expense-date-${index}`}>Date</Label>
                  <Input
                    id={`ai-expense-date-${index}`}
                    type="date"
                    value={row.date}
                    disabled={disabled}
                    onChange={(e) => updateRow(index, { date: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`ai-expense-amount-${index}`}>Amount (inc GST)</Label>
                  <Input
                    id={`ai-expense-amount-${index}`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.amount}
                    disabled={disabled}
                    onChange={(e) => updateRow(index, { amount: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Account</Label>
                  <Select
                    value={row.accountId || undefined}
                    disabled={disabled}
                    onValueChange={(value) => updateRow(index, { accountId: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick an account…" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Tax code</Label>
                  <Select
                    value={row.taxCode}
                    disabled={disabled}
                    onValueChange={(value) => updateRow(index, { taxCode: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAX_CODES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {row.proposal.notes && <p className="text-xs text-muted-foreground">{row.proposal.notes}</p>}

              {row.steps.length > 0 && (
                <div className="space-y-1 border rounded-lg p-3 bg-muted/30">
                  {row.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {step.state === 'running' && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                      {step.state === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                      {(step.state === 'failed' || step.state === 'skipped') && (
                        <XCircle className="w-4 h-4 text-destructive" />
                      )}
                      <span>{step.label}</span>
                      {step.detail && <span className="text-xs text-destructive">{step.detail}</span>}
                    </div>
                  ))}
                </div>
              )}

              {row.error && <p className="text-sm text-destructive">{row.error}</p>}

              {!row.createdExpenseId && (
                <Button type="button" size="sm" onClick={() => void createExpense(index)} disabled={row.creating}>
                  {row.creating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    'Create expense'
                  )}
                </Button>
              )}
            </div>
          )
        })}

        {rows.length > 0 && (
          <div className="flex items-center gap-3">
            {pendingRows.length > 1 && (
              <Button type="button" onClick={() => void createAll()} disabled={anyCreating}>
                {anyCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating…
                  </>
                ) : (
                  `Create all ${pendingRows.length} expenses`
                )}
              </Button>
            )}
            {rows.some((r) => r.createdExpenseId) && (
              <Button asChild variant="outline">
                <Link href="/admin/accounting/expenses">Open expenses</Link>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
