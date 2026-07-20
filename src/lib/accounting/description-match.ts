import type { PrismaClient } from '@prisma/client'

// Description-similarity scoring for matching bank-transaction/receipt text to
// chart-of-accounts history. Shared by the suggest-account API route (per-bank-
// account scoring) and the AI assistant worker (historical-mappings context).

export const GENERIC_DESCRIPTION_TOKENS = new Set([
  'australia',
  'sydney',
  'melbourne',
  'brisbane',
  'perth',
  'adelaide',
  'card',
  'cards',
  'value',
  'date',
  'debit',
  'credit',
  'purchase',
  'payment',
  'merchant',
  'bank',
  'transfer',
  'visa',
  'mastercard',
  'eftpos',
  'pos',
  'pending',
])

export function normalizeDescription(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractMeaningfulTokens(value: string) {
  const normalized = normalizeDescription(value)
  if (!normalized) return []

  const uniqueTokens: string[] = []
  const seen = new Set<string>()

  for (const token of normalized.split(' ')) {
    if (!token || seen.has(token)) continue
    if (token.length < 3) continue
    if (!/[a-z]/.test(token)) continue
    if (/^x+\d+$/.test(token)) continue
    if (/^\d+$/.test(token)) continue
    if (GENERIC_DESCRIPTION_TOKENS.has(token)) continue
    seen.add(token)
    uniqueTokens.push(token)
    if (uniqueTokens.length >= 6) break
  }

  return uniqueTokens
}

export function scoreDescriptionMatch(targetDescription: string, candidateDescription: string) {
  const targetNormalized = normalizeDescription(targetDescription)
  const candidateNormalized = normalizeDescription(candidateDescription)

  if (!targetNormalized || !candidateNormalized) return 0
  if (targetNormalized === candidateNormalized) return 10_000

  const targetTokens = extractMeaningfulTokens(targetDescription)
  const candidateTokens = new Set(extractMeaningfulTokens(candidateDescription))

  if (targetTokens.length === 0) {
    return candidateNormalized.includes(targetNormalized) || targetNormalized.includes(candidateNormalized)
      ? Math.min(targetNormalized.length, candidateNormalized.length)
      : 0
  }

  let score = 0
  let matchedTokenCount = 0

  for (const [index, token] of targetTokens.entries()) {
    if (!candidateTokens.has(token)) continue
    matchedTokenCount += 1
    score += 12 + Math.min(token.length, 12)
    if (index === 0) score += 10
  }

  if (matchedTokenCount === 0) return 0
  if (matchedTokenCount === targetTokens.length) score += 12
  else if (matchedTokenCount >= 2) score += 6

  const targetPrefix = targetTokens.slice(0, 2).join(' ')
  if (targetPrefix && candidateNormalized.includes(targetPrefix)) {
    score += 10
  }

  return score
}

export interface AccountHistoryRecord {
  /** Supplier + description text of a past expense, or a matched bank txn's description */
  text: string
  accountId: string
  date: string
}

/**
 * Recent categorisation history for the token scorer: past expenses and matched
 * bank transactions across all bank accounts. Loaded once, scored per target.
 */
export async function loadAccountHistory(prisma: PrismaClient): Promise<AccountHistoryRecord[]> {
  const [expenses, transactions] = await Promise.all([
    prisma.expense.findMany({
      select: { supplierName: true, description: true, accountId: true, date: true },
      orderBy: { date: 'desc' },
      take: 400,
    }),
    prisma.bankTransaction.findMany({
      where: {
        status: 'MATCHED',
        OR: [{ accountId: { not: null } }, { expense: { isNot: null } }],
      },
      select: { description: true, accountId: true, date: true, expense: { select: { accountId: true } } },
      orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      take: 250,
    }),
  ])

  const records: AccountHistoryRecord[] = expenses.map((e) => ({
    text: [e.supplierName, e.description].filter(Boolean).join(' '),
    accountId: e.accountId,
    date: e.date,
  }))
  for (const t of transactions) {
    const accountId = t.expense?.accountId ?? t.accountId
    if (accountId) records.push({ text: t.description, accountId, date: t.date })
  }
  return records
}

/**
 * The AI assistant's deterministic account fallback: when the model declines to
 * pick an account for a receipt, score its extracted supplier/description
 * against the categorisation history — the same scorer the Bank Accounts
 * suggest-account endpoint uses — and return the top account, restricted to
 * `allowedAccountIds` (active EXPENSE/COGS). Null when nothing matches.
 */
export function suggestAccountFromHistory(
  history: AccountHistoryRecord[],
  targetText: string,
  allowedAccountIds: Set<string>
): string | null {
  if (!normalizeDescription(targetText)) return null

  const accountScores = new Map<string, { score: number; matches: number; latestDate: string }>()
  for (const record of history) {
    if (!allowedAccountIds.has(record.accountId)) continue
    const score = scoreDescriptionMatch(targetText, record.text)
    if (score <= 0) continue
    const existing = accountScores.get(record.accountId)
    if (existing) {
      existing.score += score
      existing.matches += 1
      if (record.date > existing.latestDate) existing.latestDate = record.date
    } else {
      accountScores.set(record.accountId, { score, matches: 1, latestDate: record.date })
    }
  }

  return (
    [...accountScores.entries()].sort((left, right) => {
      const byScore = right[1].score - left[1].score
      if (byScore !== 0) return byScore
      const byMatches = right[1].matches - left[1].matches
      if (byMatches !== 0) return byMatches
      return right[1].latestDate.localeCompare(left[1].latestDate)
    })[0]?.[0] ?? null
  )
}

export interface HistoricalMapping {
  /** The supplier/description key, e.g. "officeworks" */
  label: string
  accountId: string
  accountCode: string
  accountName: string
  /** How many past records used this mapping */
  count: number
}

/**
 * How this business has historically categorised suppliers: recent expenses
 * (supplier/description → account) merged with recent matched bank transactions
 * across ALL bank accounts (description tokens → posted/linked account). Fed to
 * the AI assistant as context so it categorises receipts the way the existing
 * token scorer would — the scorer itself can't run pre-LLM because the receipt's
 * description only exists after the model reads it.
 */
export async function buildHistoricalMappings(prisma: PrismaClient, cap = 80): Promise<HistoricalMapping[]> {
  const [expenses, transactions] = await Promise.all([
    prisma.expense.findMany({
      select: { supplierName: true, description: true, accountId: true },
      orderBy: { date: 'desc' },
      take: 400,
    }),
    prisma.bankTransaction.findMany({
      where: {
        status: 'MATCHED',
        OR: [{ accountId: { not: null } }, { expense: { isNot: null } }],
      },
      select: { description: true, accountId: true, expense: { select: { accountId: true } } },
      orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      take: 250,
    }),
  ])

  // key: "<label>|<accountId>" → count
  const counts = new Map<string, { label: string; accountId: string; count: number }>()
  const add = (label: string, accountId: string) => {
    const key = `${label}|${accountId}`
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { label, accountId, count: 1 })
  }

  for (const e of expenses) {
    const label =
      extractMeaningfulTokens(e.supplierName ?? '').slice(0, 2).join(' ') ||
      extractMeaningfulTokens(e.description).slice(0, 2).join(' ')
    if (label) add(label, e.accountId)
  }
  for (const t of transactions) {
    const accountId = t.expense?.accountId ?? t.accountId
    if (!accountId) continue
    const label = extractMeaningfulTokens(t.description).slice(0, 2).join(' ')
    if (label) add(label, accountId)
  }

  const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, cap)
  if (top.length === 0) return []

  const accounts = await prisma.account.findMany({
    where: { id: { in: [...new Set(top.map((m) => m.accountId))] } },
    select: { id: true, code: true, name: true },
  })
  const accountById = new Map(accounts.map((a) => [a.id, a]))

  return top.flatMap((m) => {
    const account = accountById.get(m.accountId)
    if (!account) return []
    return [{ label: m.label, accountId: m.accountId, accountCode: account.code, accountName: account.name, count: m.count }]
  })
}
