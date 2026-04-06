/**
 * Bank CSV parser — auto-detects format from major Australian banks.
 *
 * Supported formats:
 *  - CommBank (CBA)    — Date,Amount,Description,Balance  (no header or with header)
 *  - ANZ               — Date,Amount,Description,Reference,Balance
 *  - Westpac           — Date,Amount,Description,Reference,Balance  (or tab-separated)
 *  - NAB               — Date,Amount,Narrative,Number,Running Balance
 *  - Bendigo Bank      — Date,Transaction Details,Debit,Credit,Balance
 *  - Generic           — Tries to auto-detect date + amount columns
 */

export interface ParsedTransaction {
  date: string         // YYYY-MM-DD
  description: string
  reference: string | null
  amountCents: number  // Negative = debit (money out), Positive = credit (money in)
  rawRow: Record<string, string>
}

export interface ParseResult {
  transactions: ParsedTransaction[]
  skipped: number
  format: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normaliseDate(raw: string): string | null {
  // Handles: DD/MM/YYYY, MM/DD/YYYY (detected by value >12 in pos), YYYY-MM-DD, DD-MMM-YYYY
  const s = raw.trim()

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (dmy) {
    const day = dmy[1].padStart(2, '0')
    const month = dmy[2].padStart(2, '0')
    return `${dmy[3]}-${month}-${day}`
  }

  // DD MMM YYYY or DD-MMM-YYYY (e.g. 01 Jan 2025)
  const dmonMY = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{4})$/)
  if (dmonMY) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    }
    const m = months[dmonMY[2].toLowerCase()]
    if (m) return `${dmonMY[3]}-${m}-${dmonMY[1].padStart(2, '0')}`
  }

  return null
}

function parseDollarAmount(raw: string): number | null {
  // Remove $, spaces, commas; handle (100.00) as negative
  const s = raw.trim().replace(/[$,\s]/g, '')
  if (!s || s === '-' || s === '') return null
  const negative = s.startsWith('(') && s.endsWith(')')
  const num = parseFloat(negative ? s.slice(1, -1) : s)
  if (isNaN(num)) return null
  return negative ? -num : num
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100)
}

// Simple CSV row parser that handles quoted fields
function parseCSVLine(line: string, separator = ','): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === separator && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

function detectSeparator(firstLine: string): string {
  const commas = (firstLine.match(/,/g) ?? []).length
  const tabs = (firstLine.match(/\t/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

// ── Format detectors & parsers ────────────────────────────────────────────

function isHeaderRow(row: string[]): boolean {
  const lower = row.map(c => c.toLowerCase())
  return lower.some(c => ['date', 'amount', 'description', 'narrative', 'debit', 'credit', 'balance'].includes(c))
}

function normaliseHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  headers.forEach((h, i) => {
    map[h.toLowerCase().trim().replace(/[\s_]+/g, '_')] = i
  })
  return map
}

function parseStandardFormat(
  rows: string[][],
  headerMap: Record<string, number>,
  format: string
): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []

  const dateIdx = headerMap['date'] ?? headerMap['transaction_date'] ?? headerMap['value_date'] ?? 0
  const descIdx = headerMap['description'] ?? headerMap['narrative'] ?? headerMap['transaction_details'] ?? headerMap['details'] ?? 2
  const amountIdx = headerMap['amount'] ?? -1
  const debitIdx = headerMap['debit'] ?? headerMap['debit_amount'] ?? -1
  const creditIdx = headerMap['credit'] ?? headerMap['credit_amount'] ?? -1
  const refIdx = headerMap['reference'] ?? headerMap['ref'] ?? headerMap['number'] ?? -1

  for (const row of rows) {
    if (row.length < 2) continue

    const rawDate = row[dateIdx] ?? ''
    const date = normaliseDate(rawDate)
    if (!date) continue

    const rawRow: Record<string, string> = {}
    row.forEach((v, i) => { rawRow[`col${i}`] = v })

    let amountCents = 0

    if (amountIdx !== -1) {
      const dollars = parseDollarAmount(row[amountIdx] ?? '')
      if (dollars === null) continue
      amountCents = toCents(dollars)
    } else if (debitIdx !== -1 || creditIdx !== -1) {
      // Debit = money out (negative), Credit = money in (positive)
      const debit = debitIdx !== -1 ? parseDollarAmount(row[debitIdx] ?? '') : null
      const credit = creditIdx !== -1 ? parseDollarAmount(row[creditIdx] ?? '') : null
      if (debit) amountCents -= toCents(Math.abs(debit))
      if (credit) amountCents += toCents(Math.abs(credit))
      if (debit === null && credit === null) continue
    } else {
      continue
    }

    const description = (row[descIdx] ?? '').trim()
    if (!description) continue

    transactions.push({
      date,
      description,
      reference: refIdx !== -1 ? (row[refIdx] ?? '').trim() || null : null,
      amountCents,
      rawRow,
    })
  }

  return transactions
}

// ── Main export ──────────────────────────────────────────────────────────────

export function parseCSV(csvText: string): ParseResult {
  const rawLines = csvText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)

  if (rawLines.length === 0) {
    return { transactions: [], skipped: 0, format: 'unknown' }
  }

  const sep = detectSeparator(rawLines[0])
  const allRows = rawLines.map(l => parseCSVLine(l, sep))

  // Detect if first row is a header
  let headerRow: string[] = []
  let dataRows: string[][] = allRows

  if (isHeaderRow(allRows[0])) {
    headerRow = allRows[0]
    dataRows = allRows.slice(1)
  } else {
    // No header — try to auto-detect number of columns and assign defaults
    const cols = allRows[0].length
    if (cols === 4) {
      // CommBank style: Date, Amount, Description, Balance
      headerRow = ['Date', 'Amount', 'Description', 'Balance']
    } else if (cols === 5) {
      // ANZ/Westpac: Date, Amount, Description, Reference, Balance
      headerRow = ['Date', 'Amount', 'Description', 'Reference', 'Balance']
    } else {
      // Generic guess
      headerRow = ['Date', 'Amount', 'Description']
    }
  }

  const headerMap = normaliseHeaders(headerRow)

  // Detect specific format
  let format = 'generic'
  const hLower = headerRow.map(h => h.toLowerCase().trim())
  if (hLower.includes('debit') && hLower.includes('credit')) {
    format = 'debit-credit'
  } else if (hLower.includes('narrative')) {
    format = 'nab'
  } else if (hLower.includes('number') || hLower.includes('ref')) {
    format = 'anz-westpac'
  } else if (hLower.includes('amount') && hLower.length === 4) {
    format = 'commbank'
  }

  const transactions = parseStandardFormat(dataRows, headerMap, format)

  return {
    transactions,
    skipped: dataRows.length - transactions.length,
    format,
  }
}

// Deduplicate against existing transactions by (bankAccountId, date, amountCents, description)
export function deduplicateTransactions(
  parsed: ParsedTransaction[],
  existing: Array<{ date: string; amountCents: number; description: string }>
): { toInsert: ParsedTransaction[]; duplicates: number } {
  const existingSet = new Set(
    existing.map(e => `${e.date}|${e.amountCents}|${e.description.trim().toLowerCase()}`)
  )

  const toInsert: ParsedTransaction[] = []
  let duplicates = 0

  for (const t of parsed) {
    const key = `${t.date}|${t.amountCents}|${t.description.trim().toLowerCase()}`
    if (existingSet.has(key)) {
      duplicates++
    } else {
      toInsert.push(t)
      // Add to set to catch duplicates within the import itself
      existingSet.add(key)
    }
  }

  return { toInsert, duplicates }
}
