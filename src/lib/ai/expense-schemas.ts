import { z } from 'zod'
import { ISO_DATE_RE } from './proposal-schemas'

// Expense-extraction JSON contract shared by the worker (validation) and the
// admin UI (typing). Structured-output-safe like proposal-schemas.ts: no
// min/max/format constraints — dates and amounts are enforced post-parse by
// applyExpenseGuards().

const MAX_DESCRIPTION_LENGTH = 5000 // matches the expenses API schema

export const ExpenseProposalSchema = z.object({
  // Which <receipt index="n"> this entry came from — several entries may share
  // an index when one attachment contains multiple receipts.
  attachmentIndex: z.number(),
  date: z.string(), // YYYY-MM-DD, guard-enforced
  supplierName: z.string().nullable(),
  description: z.string(),
  // GST-inclusive total in DOLLARS as printed on the receipt (the expenses API
  // takes dollars and computes the GST split server-side)
  amountIncGst: z.number(),
  // Whether the receipt shows GST / the supplier is clearly GST-registered
  gstIncluded: z.boolean(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']),
  // Must be an id from the <chart_of_accounts> list — enforced by applyExpenseGuards
  accountId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  // Currency oddities, unreadable fields, categorisation doubts, etc.
  notes: z.string().nullable(),
})

export const ExpenseResultSchema = z.object({
  expenses: z.array(ExpenseProposalSchema),
  // Free-text notes about guesses/ambiguities — surfaced in the review UI
  assumptions: z.array(z.string()),
})

// Plain JSON schema for Ollama's `format` (grammar-constrained decoding)
export const ExpenseResultJsonSchema = z.toJSONSchema(ExpenseResultSchema) as Record<string, unknown>

export type ExpenseProposal = z.infer<typeof ExpenseProposalSchema>
export type ExpenseResult = z.infer<typeof ExpenseResultSchema>

/** Worker-attached enrichment: an existing expense with the same date + amount */
export interface ExpenseDuplicateHint {
  expenseId: string
  date: string
  amountIncGst: number // dollars
  description: string
}

export interface ResolvedExpenseProposal extends ExpenseProposal {
  possibleDuplicate: ExpenseDuplicateHint | null
}

export interface ResolvedExpenseResult {
  expenses: ResolvedExpenseProposal[]
  assumptions: string[]
}

export interface ExpenseGuardContext {
  /** Active EXPENSE/COGS accounts keyed by id — the only valid accountId values */
  accountsById: Map<string, { code: string; name: string }>
  today: string // YYYY-MM-DD
  attachmentCount: number
}

/**
 * Hard post-validation guards applied after zod parsing, regardless of provider.
 * Same contract as applyProposalGuards: pure, returns a new object, and records
 * every dropped/corrected value in `assumptions`.
 */
export function applyExpenseGuards(input: ExpenseResult, ctx: ExpenseGuardContext): ExpenseResult {
  const result: ExpenseResult = JSON.parse(JSON.stringify(input))
  const note = (msg: string) => {
    result.assumptions.push(`[guard] ${msg}`)
  }

  result.expenses = result.expenses.filter((e, i) => {
    const label = e.supplierName || e.description || `entry ${i + 1}`

    if (!Number.isFinite(e.amountIncGst) || e.amountIncGst <= 0) {
      note(`Expense "${label}" dropped — amount "${e.amountIncGst}" is not a positive number.`)
      return false
    }
    e.amountIncGst = Math.round(e.amountIncGst * 100) / 100

    if (!ISO_DATE_RE.test(e.date)) {
      note(`Expense "${label}": unreadable date "${e.date}" — replaced with today (${ctx.today}). Check it before creating.`)
      e.date = ctx.today
    } else if (e.date > ctx.today) {
      note(`Expense "${label}" is dated in the future (${e.date}) — check the date before creating.`)
    }

    if (e.accountId && !ctx.accountsById.has(e.accountId)) {
      // Models sometimes emit the account CODE (e.g. "6-9220") instead of the id —
      // resolve it rather than throwing the correct pick away
      const value = e.accountId.trim().toLowerCase()
      const byCode = [...ctx.accountsById.entries()].find(([, a]) => a.code.toLowerCase() === value)
      if (byCode) {
        e.accountId = byCode[0]
      } else {
        note(`Expense "${label}": suggested account id "${e.accountId}" is not a known expense account — cleared. Pick one manually.`)
        e.accountId = null
      }
    }

    if (!Number.isFinite(e.attachmentIndex) || e.attachmentIndex < 0 || e.attachmentIndex >= ctx.attachmentCount) {
      note(`Expense "${label}" referenced a receipt that doesn't exist (index ${e.attachmentIndex}) — linked to the first receipt instead.`)
      e.attachmentIndex = 0
    } else {
      e.attachmentIndex = Math.trunc(e.attachmentIndex)
    }

    if (!e.gstIncluded && e.taxCode === 'GST') {
      note(`Expense "${label}": marked as no GST shown but tax code GST — double-check whether GST applies.`)
    }

    e.supplierName = e.supplierName?.trim() || null
    e.description = e.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
    if (!e.description) {
      e.description = e.supplierName ?? 'Expense'
      note(`Expense "${label}": empty description — filled from the supplier name.`)
    }

    return true
  })

  return result
}
