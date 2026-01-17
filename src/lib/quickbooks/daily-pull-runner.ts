import { prisma } from '@/lib/db'
import { getQuickBooksConfig, qboQuery, refreshQuickBooksAccessToken, toQboDateTime } from '@/lib/quickbooks/qbo'
import { mergeQboInvoicesIntoSalesTables, mergeQboPaymentsIntoSalesTables, mergeQboQuotesIntoSalesTables } from '@/lib/sales/server-qbo-merge'

export type QboDailyPullStepSummary = {
  step: 'customers' | 'quotes' | 'invoices' | 'payments'
  fetched: number
  stored?: { created: number; updated: number; skipped: number }
  note?: string
}

export type QboDailyPullResult = {
  ok: boolean
  startedAt: Date
  finishedAt: Date
  lookbackDays: number
  steps: QboDailyPullStepSummary[]
  message: string
}

type DailyPullOptions = {
  sleepBetweenStepsMs?: number
  sleepFn?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampLookbackDays(days: number): number {
  const d = Number.isFinite(days) ? Math.floor(days) : 7
  return Math.min(Math.max(d, 0), 3650)
}

function parseQboDate(dateStr: unknown): Date | null {
  if (typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseQboDateTime(dateStr: unknown): Date | null {
  if (typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function toYmd(date: Date | null): string | null {
  if (!date) return null
  try {
    return date.toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function ensurePrefix(value: string, prefix: string): string {
  const v = value.trim()
  if (!v) return prefix
  const upper = v.toUpperCase()
  if (upper.startsWith(prefix.toUpperCase())) return v
  return `${prefix}${v}`
}

function dollarsToCentsSafe(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

type QboCustomer = {
  Id?: string
  DisplayName?: string
  GivenName?: string
  FamilyName?: string
  Active?: boolean
  PrimaryPhone?: { FreeFormNumber?: string }
  PrimaryEmailAddr?: { Address?: string }
  WebAddr?: { URI?: string }
  BillAddr?: {
    Line1?: string
    Line2?: string
    Line3?: string
    Line4?: string
    Line5?: string
    City?: string
    CountrySubDivisionCode?: string
    PostalCode?: string
    Country?: string
  }
  Notes?: string
}

function formatAddress(addr: QboCustomer['BillAddr']): string | null {
  if (!addr) return null
  const lines: string[] = []
  for (const l of [addr.Line1, addr.Line2, addr.Line3, addr.Line4, addr.Line5]) {
    const s = typeof l === 'string' ? l.trim() : ''
    if (s) lines.push(s)
  }

  const localityParts = [addr.City, addr.CountrySubDivisionCode, addr.PostalCode]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)

  if (localityParts.length > 0) lines.push(localityParts.join(' '))

  const country = typeof addr.Country === 'string' ? addr.Country.trim() : ''
  if (country) lines.push(country)

  return lines.length > 0 ? lines.join('\n') : null
}

async function ensurePrimaryRecipient(clientId: string, email: string, name: string | null) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return

  const existing = await prisma.clientRecipient.findFirst({
    where: { clientId, email: normalizedEmail },
    select: { id: true, isPrimary: true },
  })

  if (!existing) {
    const alreadyHasPrimary = await prisma.clientRecipient.findFirst({
      where: { clientId, isPrimary: true },
      select: { id: true },
    })

    await prisma.clientRecipient.create({
      data: {
        clientId,
        email: normalizedEmail,
        name: name?.trim() || null,
        isPrimary: !alreadyHasPrimary,
        receiveNotifications: true,
      },
    })
    return
  }

  if (!existing.isPrimary) {
    const alreadyHasPrimary = await prisma.clientRecipient.findFirst({
      where: { clientId, isPrimary: true },
      select: { id: true },
    })

    if (!alreadyHasPrimary) {
      await prisma.clientRecipient.update({ where: { id: existing.id }, data: { isPrimary: true } })
    }
  }
}

function normalizeEstimateLines(raw: any): Array<{ description: string; quantity: number; unitPriceCents: number }> {
  const lines = Array.isArray(raw?.Line) ? raw.Line : []
  const out: Array<{ description: string; quantity: number; unitPriceCents: number }> = []

  for (const line of lines) {
    if (!line) continue

    const amount = coerceNumber(line?.Amount)
    const detailType = typeof line?.DetailType === 'string' ? line.DetailType : ''
    const salesDetail = detailType === 'SalesItemLineDetail' ? line?.SalesItemLineDetail : null

    const qtyRaw = salesDetail ? coerceNumber(salesDetail?.Qty) : null
    const qty = qtyRaw && qtyRaw > 0 ? qtyRaw : 1

    const unitPriceRaw = salesDetail ? coerceNumber(salesDetail?.UnitPrice) : null
    const unitPrice = unitPriceRaw ?? (amount !== null ? amount / qty : 0)

    const descFromDetail = typeof salesDetail?.ItemRef?.name === 'string' ? salesDetail.ItemRef.name.trim() : ''
    const descFromLine = typeof line?.Description === 'string' ? line.Description.trim() : ''
    const description = descFromLine || descFromDetail || ''

    if (detailType === 'SubTotalLineDetail') continue
    if (!description && (!amount || amount === 0)) continue

    out.push({
      description: description || 'Line item',
      quantity: qty,
      unitPriceCents: dollarsToCentsSafe(unitPrice),
    })
  }

  return out
}

function normalizeInvoiceLines(raw: any): Array<{ description: string; quantity: number; unitPriceCents: number }> {
  const lines = Array.isArray(raw?.Line) ? raw.Line : []
  const out: Array<{ description: string; quantity: number; unitPriceCents: number }> = []

  for (const line of lines) {
    if (!line) continue

    const amount = coerceNumber(line?.Amount)
    const detailType = typeof line?.DetailType === 'string' ? line.DetailType : ''
    const salesDetail = detailType === 'SalesItemLineDetail' ? line?.SalesItemLineDetail : null

    const qtyRaw = salesDetail ? coerceNumber(salesDetail?.Qty) : null
    const qty = qtyRaw && qtyRaw > 0 ? qtyRaw : 1

    const unitPriceRaw = salesDetail ? coerceNumber(salesDetail?.UnitPrice) : null
    const unitPrice = unitPriceRaw ?? (amount !== null ? amount / qty : 0)

    const descFromDetail = typeof salesDetail?.ItemRef?.name === 'string' ? salesDetail.ItemRef.name.trim() : ''
    const descFromLine = typeof line?.Description === 'string' ? line.Description.trim() : ''
    const description = descFromLine || descFromDetail || ''

    if (detailType === 'SubTotalLineDetail') continue
    if (!description && (!amount || amount === 0)) continue

    out.push({
      description: description || 'Line item',
      quantity: qty,
      unitPriceCents: dollarsToCentsSafe(unitPrice),
    })
  }

  return out
}

function extractAppliedInvoiceQboIds(payment: any): Array<{ invoiceQboId: string; amount: number | null }> {
  const lines = Array.isArray(payment?.Line) ? payment.Line : []
  const out: Array<{ invoiceQboId: string; amount: number | null }> = []

  for (const line of lines) {
    if (!line) continue
    const linked = Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : []
    const linkedInvoices = linked
      .map((lt: any) => {
        const txnType = typeof lt?.TxnType === 'string' ? lt.TxnType.trim() : ''
        const txnId = typeof lt?.TxnId === 'string' ? lt.TxnId.trim() : ''
        if (txnType !== 'Invoice' || !txnId) return null
        return txnId
      })
      .filter(Boolean) as string[]

    if (linkedInvoices.length === 0) continue

    const maybeAmount = linkedInvoices.length === 1 ? coerceNumber(line?.Amount) : null

    for (const invoiceQboId of linkedInvoices) {
      out.push({ invoiceQboId, amount: maybeAmount })
    }
  }

  const seen = new Set<string>()
  const deduped: Array<{ invoiceQboId: string; amount: number | null }> = []
  for (const row of out) {
    if (seen.has(row.invoiceQboId)) continue
    seen.add(row.invoiceQboId)
    deduped.push(row)
  }
  return deduped
}

async function pullCustomers(lookbackDays: number, auth: Awaited<ReturnType<typeof refreshQuickBooksAccessToken>>): Promise<QboDailyPullStepSummary> {
  const days = clampLookbackDays(lookbackDays)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceQbo = toQboDateTime(since)

  const pageSize = 1000
  let startPosition = 1

  const customers: QboCustomer[] = []
  while (true) {
    const whereClause = days > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
    const query = `SELECT * FROM Customer${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    const result = await qboQuery<any>(auth, query)
    const page = (result?.QueryResponse?.Customer ?? []) as QboCustomer[]
    customers.push(...page)
    if (page.length < pageSize) break
    startPosition += pageSize
  }

  let created = 0
  let updated = 0
  let linkedByName = 0
  let skipped = 0
  let recipientsCreatedOrLinked = 0

  for (const c of customers) {
    const qbId = typeof c.Id === 'string' ? c.Id.trim() : ''
    const displayName = typeof c.DisplayName === 'string' ? c.DisplayName.trim() : ''
    if (!qbId || !displayName) {
      skipped += 1
      continue
    }

    const nextAddress = formatAddress(c.BillAddr)
    const nextPhone = typeof c.PrimaryPhone?.FreeFormNumber === 'string' ? c.PrimaryPhone.FreeFormNumber.trim() : null
    const nextWebsite = typeof c.WebAddr?.URI === 'string' ? c.WebAddr.URI.trim() : null
    const nextNotes = typeof c.Notes === 'string' ? c.Notes.trim() : null
    const nextActive = c.Active !== false
    const nextEmail = typeof c.PrimaryEmailAddr?.Address === 'string' ? c.PrimaryEmailAddr.Address.trim() : ''
    const nextRecipientName = (
      [c.GivenName, c.FamilyName]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .join(' ') ||
      (typeof c.DisplayName === 'string' ? c.DisplayName.trim() : '') ||
      null
    )

    const existingByQb = await prisma.client.findUnique({
      where: { quickbooksCustomerId: qbId },
      select: { id: true, address: true, phone: true, website: true, notes: true, active: true },
    })

    if (existingByQb) {
      const data: any = {}
      if ((!existingByQb.address || existingByQb.address.trim() === '') && nextAddress) data.address = nextAddress
      if ((!existingByQb.phone || existingByQb.phone.trim() === '') && nextPhone) data.phone = nextPhone
      if ((!existingByQb.website || existingByQb.website.trim() === '') && nextWebsite) data.website = nextWebsite
      if ((!existingByQb.notes || existingByQb.notes.trim() === '') && nextNotes) data.notes = nextNotes
      if (existingByQb.active !== nextActive) data.active = nextActive

      if (Object.keys(data).length > 0) {
        await prisma.client.update({ where: { id: existingByQb.id }, data })
        updated += 1
      } else {
        skipped += 1
      }

      if (nextEmail) {
        await ensurePrimaryRecipient(existingByQb.id, nextEmail, nextRecipientName)
        recipientsCreatedOrLinked += 1
      }
      continue
    }

    const existingByName = await prisma.client.findUnique({
      where: { name: displayName },
      select: { id: true, quickbooksCustomerId: true, address: true, phone: true, website: true, notes: true, active: true },
    })

    if (existingByName && !existingByName.quickbooksCustomerId) {
      const data: any = { quickbooksCustomerId: qbId }
      if ((!existingByName.address || existingByName.address.trim() === '') && nextAddress) data.address = nextAddress
      if ((!existingByName.phone || existingByName.phone.trim() === '') && nextPhone) data.phone = nextPhone
      if ((!existingByName.website || existingByName.website.trim() === '') && nextWebsite) data.website = nextWebsite
      if ((!existingByName.notes || existingByName.notes.trim() === '') && nextNotes) data.notes = nextNotes
      if (existingByName.active !== nextActive) data.active = nextActive

      await prisma.client.update({ where: { id: existingByName.id }, data })
      linkedByName += 1

      if (nextEmail) {
        await ensurePrimaryRecipient(existingByName.id, nextEmail, nextRecipientName)
        recipientsCreatedOrLinked += 1
      }
      continue
    }

    const createdClient = await prisma.client.create({
      data: {
        name: displayName,
        quickbooksCustomerId: qbId,
        address: nextAddress,
        phone: nextPhone,
        website: nextWebsite,
        notes: nextNotes,
        active: nextActive,
      },
    })
    created += 1

    if (nextEmail) {
      await ensurePrimaryRecipient(createdClient.id, nextEmail, nextRecipientName)
      recipientsCreatedOrLinked += 1
    }
  }

  return {
    step: 'customers',
    fetched: customers.length,
    stored: { created, updated: updated + linkedByName, skipped },
    note: `linkedByName=${linkedByName}, recipients=${recipientsCreatedOrLinked}`,
  }
}

async function pullQuotes(lookbackDays: number, auth: Awaited<ReturnType<typeof refreshQuickBooksAccessToken>>): Promise<QboDailyPullStepSummary> {
  const days = clampLookbackDays(lookbackDays)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceQbo = toQboDateTime(since)

  const pageSize = 1000
  let startPosition = 1

  const all: any[] = []
  while (true) {
    const whereClause = days > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
    const query = `SELECT * FROM Estimate${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    const result = await qboQuery<any>(auth, query)
    const page = (result?.QueryResponse?.Estimate ?? []) as any[]
    all.push(...page)
    if (page.length < pageSize) break
    startPosition += pageSize
  }

  let created = 0
  let updated = 0
  let skipped = 0

  for (const e of all) {
    const qboId = typeof e?.Id === 'string' ? e.Id.trim() : ''
    if (!qboId) {
      skipped += 1
      continue
    }

    const existing = await (prisma as any).quickBooksEstimateImport.findUnique({
      where: { qboId },
      select: { id: true },
    })

    const data = {
      qboId,
      docNumber: typeof e?.DocNumber === 'string' ? e.DocNumber.trim() : null,
      txnDate: parseQboDate(e?.TxnDate),
      totalAmt: typeof e?.TotalAmt === 'number' ? e.TotalAmt : null,
      customerQboId: typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : null,
      customerName: typeof e?.CustomerRef?.name === 'string' ? e.CustomerRef.name.trim() : null,
      privateNote: typeof e?.PrivateNote === 'string' ? e.PrivateNote.trim() : null,
      lastUpdatedTime: parseQboDateTime(e?.MetaData?.LastUpdatedTime),
      raw: e,
    }

    await (prisma as any).quickBooksEstimateImport.upsert({
      where: { qboId },
      create: data,
      update: data,
    })

    if (existing) updated += 1
    else created += 1
  }

  const customerQboIds = Array.from(
    new Set(
      all
        .map((e) => (typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : ''))
        .filter(Boolean)
    )
  )

  const clients = customerQboIds.length
    ? await prisma.client.findMany({
        where: { quickbooksCustomerId: { in: customerQboIds } },
        select: { id: true, quickbooksCustomerId: true },
      })
    : []
  const clientIdByCustomerQboId = new Map(clients.map((c) => [String(c.quickbooksCustomerId), c.id]))

  const nativeQuotes = all
    .map((e) => {
      const qboId = typeof e?.Id === 'string' ? e.Id.trim() : ''
      const customerQboId = typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : null
      const clientId = customerQboId ? (clientIdByCustomerQboId.get(customerQboId) ?? null) : null

      const txnDateYmd = toYmd(parseQboDate(e?.TxnDate))
      const validUntilYmd = toYmd(parseQboDate(e?.ExpirationDate))

      const rawDocNumber =
        typeof e?.DocNumber === 'string' && e.DocNumber.trim() ? e.DocNumber.trim() : `QBO-EST-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'EST-')

      return {
        qboId,
        docNumber,
        txnDate: txnDateYmd,
        validUntil: validUntilYmd,
        customerQboId,
        clientId,
        customerName: typeof e?.CustomerRef?.name === 'string' ? e.CustomerRef.name.trim() : null,
        customerMemo: typeof e?.CustomerMemo?.value === 'string' ? e.CustomerMemo.value.trim() : null,
        privateNote: typeof e?.PrivateNote === 'string' ? e.PrivateNote.trim() : null,
        lines: normalizeEstimateLines(e),
      }
    })
    .filter((q) => q.qboId)

  await mergeQboQuotesIntoSalesTables(nativeQuotes)

  return { step: 'quotes', fetched: all.length, stored: { created, updated, skipped } }
}

async function pullInvoices(lookbackDays: number, auth: Awaited<ReturnType<typeof refreshQuickBooksAccessToken>>): Promise<QboDailyPullStepSummary> {
  const days = clampLookbackDays(lookbackDays)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceQbo = toQboDateTime(since)

  const pageSize = 1000
  let startPosition = 1

  const all: any[] = []
  while (true) {
    const whereClause = days > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
    const query = `SELECT * FROM Invoice${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    const result = await qboQuery<any>(auth, query)
    const page = (result?.QueryResponse?.Invoice ?? []) as any[]
    all.push(...page)
    if (page.length < pageSize) break
    startPosition += pageSize
  }

  let created = 0
  let updated = 0
  let skipped = 0

  for (const inv of all) {
    const qboId = typeof inv?.Id === 'string' ? inv.Id.trim() : ''
    if (!qboId) {
      skipped += 1
      continue
    }

    const existing = await (prisma as any).quickBooksInvoiceImport.findUnique({
      where: { qboId },
      select: { id: true },
    })

    const data = {
      qboId,
      docNumber: typeof inv?.DocNumber === 'string' ? inv.DocNumber.trim() : null,
      txnDate: parseQboDate(inv?.TxnDate),
      dueDate: parseQboDate(inv?.DueDate),
      totalAmt: typeof inv?.TotalAmt === 'number' ? inv.TotalAmt : null,
      balance: typeof inv?.Balance === 'number' ? inv.Balance : null,
      customerQboId: typeof inv?.CustomerRef?.value === 'string' ? inv.CustomerRef.value.trim() : null,
      customerName: typeof inv?.CustomerRef?.name === 'string' ? inv.CustomerRef.name.trim() : null,
      privateNote: typeof inv?.PrivateNote === 'string' ? inv.PrivateNote.trim() : null,
      lastUpdatedTime: parseQboDateTime(inv?.MetaData?.LastUpdatedTime),
      raw: inv,
    }

    await (prisma as any).quickBooksInvoiceImport.upsert({
      where: { qboId },
      create: data,
      update: data,
    })

    if (existing) updated += 1
    else created += 1
  }

  const customerQboIds = Array.from(
    new Set(
      all
        .map((e) => (typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : ''))
        .filter(Boolean)
    )
  )

  const clients = customerQboIds.length
    ? await prisma.client.findMany({
        where: { quickbooksCustomerId: { in: customerQboIds } },
        select: { id: true, quickbooksCustomerId: true },
      })
    : []
  const clientIdByCustomerQboId = new Map(clients.map((c) => [String(c.quickbooksCustomerId), c.id]))

  const nativeInvoices = all
    .map((inv) => {
      const qboId = typeof inv?.Id === 'string' ? inv.Id.trim() : ''
      const customerQboId = typeof inv?.CustomerRef?.value === 'string' ? inv.CustomerRef.value.trim() : null
      const clientId = customerQboId ? (clientIdByCustomerQboId.get(customerQboId) ?? null) : null

      const txnDateYmd = toYmd(parseQboDate(inv?.TxnDate))
      const dueDateYmd = toYmd(parseQboDate(inv?.DueDate))

      const rawDocNumber =
        typeof inv?.DocNumber === 'string' && inv.DocNumber.trim() ? inv.DocNumber.trim() : `QBO-INV-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'INV-')

      return {
        qboId,
        docNumber,
        txnDate: txnDateYmd,
        dueDate: dueDateYmd,
        customerQboId,
        clientId,
        customerName: typeof inv?.CustomerRef?.name === 'string' ? inv.CustomerRef.name.trim() : null,
        customerMemo: typeof inv?.CustomerMemo?.value === 'string' ? inv.CustomerMemo.value.trim() : null,
        privateNote: typeof inv?.PrivateNote === 'string' ? inv.PrivateNote.trim() : null,
        lines: normalizeInvoiceLines(inv),
      }
    })
    .filter((i) => i.qboId)

  await mergeQboInvoicesIntoSalesTables(nativeInvoices)

  return { step: 'invoices', fetched: all.length, stored: { created, updated, skipped } }
}

async function pullPayments(lookbackDays: number, auth: Awaited<ReturnType<typeof refreshQuickBooksAccessToken>>): Promise<QboDailyPullStepSummary> {
  const days = clampLookbackDays(lookbackDays)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceQbo = toQboDateTime(since)

  const pageSize = 1000
  let startPosition = 1

  const all: any[] = []
  while (true) {
    const whereClause = days > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
    const query = `SELECT * FROM Payment${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    const result = await qboQuery<any>(auth, query)
    const page = (result?.QueryResponse?.Payment ?? []) as any[]
    all.push(...page)
    if (page.length < pageSize) break
    startPosition += pageSize
  }

  let created = 0
  let updated = 0
  let skipped = 0
  let skippedUnmatchedInvoice = 0
  let appliedLinksCreated = 0

  const allAppliedInvoiceQboIds = Array.from(
    new Set(
      all
        .flatMap((p) => extractAppliedInvoiceQboIds(p).map((x) => x.invoiceQboId))
        .filter(Boolean)
    )
  )

  const invoiceImports = allAppliedInvoiceQboIds.length
    ? await (prisma as any).quickBooksInvoiceImport.findMany({
        where: { qboId: { in: allAppliedInvoiceQboIds } },
        select: { id: true, qboId: true, customerQboId: true },
      })
    : []
  const invoiceImportIdByQboId = new Map<string, string>(invoiceImports.map((i: any) => [String(i.qboId), i.id]))

  const customerQboIds = Array.from(
    new Set<string>(
      invoiceImports
        .map((i: any) => (typeof i?.customerQboId === 'string' ? i.customerQboId.trim() : null))
        .filter((v: any): v is string => typeof v === 'string' && Boolean(v))
    )
  )
  const clients = customerQboIds.length
    ? await prisma.client.findMany({
        where: { quickbooksCustomerId: { in: customerQboIds } },
        select: { id: true, quickbooksCustomerId: true },
      })
    : []
  const clientIdByCustomerQboId = new Map(clients.map((c) => [String(c.quickbooksCustomerId), c.id]))

  const customerQboIdByInvoiceQboId = new Map<string, string | null>(
    invoiceImports.map((i: any) => [String(i.qboId), typeof i?.customerQboId === 'string' ? i.customerQboId.trim() : null])
  )

  const nativePayments: Array<{
    paymentQboId: string
    invoiceQboId: string
    txnDate: string | null
    amountCents: number
    method: string
    reference: string
    clientId: string | null
  }> = []

  let nativeOmittedMissingAmount = 0

  for (const p of all) {
    const qboId = typeof p?.Id === 'string' ? p.Id.trim() : ''
    if (!qboId) {
      skipped += 1
      continue
    }

    const appliedAll = extractAppliedInvoiceQboIds(p)
    const appliedMatched = appliedAll.filter((row) => invoiceImportIdByQboId.has(row.invoiceQboId))
    if (appliedMatched.length === 0) {
      skippedUnmatchedInvoice += 1
      continue
    }

    const txnDateYmd = toYmd(parseQboDate(p?.TxnDate))
    const paymentMethod = typeof p?.PaymentMethodRef?.name === 'string' ? p.PaymentMethodRef.name.trim() : 'QuickBooks'
    const reference = typeof p?.PaymentRefNum === 'string' && p.PaymentRefNum.trim() ? p.PaymentRefNum.trim() : `QBO-PAY-${qboId}`
    const totalAmt = typeof p?.TotalAmt === 'number' ? p.TotalAmt : null

    for (const row of appliedMatched) {
      let amount: number | null = row.amount
      if (amount === null) {
        if (appliedMatched.length === 1 && totalAmt !== null) amount = totalAmt
        else {
          nativeOmittedMissingAmount += 1
          continue
        }
      }

      if (amount === null) {
        nativeOmittedMissingAmount += 1
        continue
      }

      const invoiceCustomerQboId = customerQboIdByInvoiceQboId.get(row.invoiceQboId) ?? null
      const clientId = invoiceCustomerQboId ? (clientIdByCustomerQboId.get(invoiceCustomerQboId) ?? null) : null

      nativePayments.push({
        paymentQboId: qboId,
        invoiceQboId: row.invoiceQboId,
        txnDate: txnDateYmd,
        amountCents: Math.round(amount * 100),
        method: paymentMethod || 'QuickBooks',
        reference,
        clientId,
      })
    }

    const existing = await (prisma as any).quickBooksPaymentImport.findUnique({
      where: { qboId },
      select: { id: true },
    })

    const data = {
      qboId,
      txnDate: parseQboDate(p?.TxnDate),
      totalAmt: typeof p?.TotalAmt === 'number' ? p.TotalAmt : null,
      customerQboId: typeof p?.CustomerRef?.value === 'string' ? p.CustomerRef.value.trim() : null,
      customerName: typeof p?.CustomerRef?.name === 'string' ? p.CustomerRef.name.trim() : null,
      paymentRefNum: typeof p?.PaymentRefNum === 'string' ? p.PaymentRefNum.trim() : null,
      privateNote: typeof p?.PrivateNote === 'string' ? p.PrivateNote.trim() : null,
      lastUpdatedTime: parseQboDateTime(p?.MetaData?.LastUpdatedTime),
      raw: p,
    }

    const saved = await (prisma as any).quickBooksPaymentImport.upsert({
      where: { qboId },
      create: data,
      update: data,
      select: { id: true },
    })

    if (existing) updated += 1
    else created += 1

    await (prisma as any).quickBooksPaymentAppliedInvoice.deleteMany({
      where: { paymentImportId: saved.id },
    })

    for (const row of appliedMatched) {
      const invoiceImportId = invoiceImportIdByQboId.get(row.invoiceQboId) ?? null
      await (prisma as any).quickBooksPaymentAppliedInvoice.create({
        data: {
          paymentImportId: saved.id,
          invoiceQboId: row.invoiceQboId,
          invoiceImportId,
          amount: row.amount,
        },
      })
      appliedLinksCreated += 1
    }
  }

  await mergeQboPaymentsIntoSalesTables(nativePayments)

  return {
    step: 'payments',
    fetched: all.length,
    stored: { created, updated, skipped: skipped + skippedUnmatchedInvoice },
    note: `skippedUnmatchedInvoice=${skippedUnmatchedInvoice}, appliedLinks=${appliedLinksCreated}, omittedMissingAmount=${nativeOmittedMissingAmount}`,
  }
}

export async function runQuickBooksDailyPull(lookbackDaysRaw: number, options: DailyPullOptions = {}): Promise<QboDailyPullResult> {
  const startedAt = new Date()
  const lookbackDays = clampLookbackDays(lookbackDaysRaw)

  const cfg = await getQuickBooksConfig()
  if (!cfg.configured) {
    const finishedAt = new Date()
    return {
      ok: false,
      startedAt,
      finishedAt,
      lookbackDays,
      steps: [],
      message: `QuickBooks not configured. Missing: ${cfg.missing.join(', ')}`,
    }
  }

  const auth = await refreshQuickBooksAccessToken()

  const sleepBetweenStepsMs = options.sleepBetweenStepsMs ?? 0
  const sleepFn = options.sleepFn ?? defaultSleep

  const steps: QboDailyPullStepSummary[] = []

  steps.push(await pullCustomers(lookbackDays, auth))
  if (sleepBetweenStepsMs > 0) await sleepFn(sleepBetweenStepsMs)

  steps.push(await pullQuotes(lookbackDays, auth))
  if (sleepBetweenStepsMs > 0) await sleepFn(sleepBetweenStepsMs)

  steps.push(await pullInvoices(lookbackDays, auth))
  if (sleepBetweenStepsMs > 0) await sleepFn(sleepBetweenStepsMs)

  steps.push(await pullPayments(lookbackDays, auth))

  const finishedAt = new Date()
  const message = steps
    .map((s) => {
      const stored = s.stored ? `stored(c=${s.stored.created},u=${s.stored.updated},s=${s.stored.skipped})` : ''
      return `${s.step}: fetched=${s.fetched}${stored ? ` ${stored}` : ''}`
    })
    .join(' | ')

  return {
    ok: true,
    startedAt,
    finishedAt,
    lookbackDays,
    steps,
    message,
  }
}
