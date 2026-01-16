import crypto from 'crypto'
import { prisma } from '../lib/db'
import {
  EMAIL_THEME,
  buildCompanyLogoUrl,
  emailCardStyle,
  emailPrimaryButtonStyle,
  escapeHtml,
  getEmailSettings,
  renderEmailShell,
  sendEmail,
} from '../lib/email'
import { renderInvoicePdfBytes, renderQuotePdfBytes } from '../lib/sales/pdf'
import type { PdfPartyInfo } from '../lib/sales/pdf'
import type { SalesInvoice, SalesQuote, SalesSettings } from '../lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '../lib/sales/money'
import { calcStripeGrossUpCents } from '../lib/sales/stripe-fees'
import { salesInvoiceFromDb, salesQuoteFromDb, salesSettingsFromDb } from '../lib/sales/db-mappers'

function parseYmd(value: unknown): Date | null {
  const s = typeof value === 'string' ? value.trim() : ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null
  const d = new Date(yyyy, mm - 1, dd)
  return Number.isFinite(d.getTime()) ? d : null
}

function ymdLocal(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function isWeekday(d: Date): boolean {
  const day = d.getDay()
  return day !== 0 && day !== 6
}

function addBusinessDaysYmd(startYmd: string, businessDays: number): string | null {
  const start = parseYmd(startYmd)
  if (!start) return null
  const n = Math.trunc(Number(businessDays))
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return startYmd

  const d = new Date(start)
  let remaining = n
  while (remaining > 0) {
    d.setDate(d.getDate() + 1)
    if (isWeekday(d)) remaining -= 1
  }
  return ymdLocal(d)
}

function subBusinessDaysYmd(startYmd: string, businessDays: number): string | null {
  const start = parseYmd(startYmd)
  if (!start) return null
  const n = Math.trunc(Number(businessDays))
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return startYmd

  const d = new Date(start)
  let remaining = n
  while (remaining > 0) {
    d.setDate(d.getDate() - 1)
    if (isWeekday(d)) remaining -= 1
  }
  return ymdLocal(d)
}

function safeOriginFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  try {
    return new URL(s).origin
  } catch {
    return null
  }
}

function computeQuoteShareExpiresAt(validUntilYmd: string | null): Date | null {
  const until = validUntilYmd ? parseYmd(validUntilYmd) : null
  if (!until) return null
  const eod = endOfDayLocal(until)
  const out = new Date(eod)
  out.setDate(out.getDate() + 30)
  return out
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function firstCurrencyFromCsv(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const first = raw.split(',')[0]?.trim().toUpperCase()
  return first && /^[A-Z]{3}$/.test(first) ? first : 'AUD'
}

function invoiceTotalCents(inv: SalesInvoice, settings: SalesSettings): number {
  const taxRatePercent = Number((settings as any)?.taxRatePercent)
  const rate = Number.isFinite(taxRatePercent) ? taxRatePercent : 10
  const subtotal = sumLineItemsSubtotal(Array.isArray((inv as any)?.items) ? (inv as any).items : [])
  const tax = sumLineItemsTax(Array.isArray((inv as any)?.items) ? (inv as any).items : [], rate)
  return subtotal + tax
}

function quoteTotalCents(q: SalesQuote, settings: SalesSettings): number {
  const taxRatePercent = Number((settings as any)?.taxRatePercent)
  const rate = Number.isFinite(taxRatePercent) ? taxRatePercent : 10
  const subtotal = sumLineItemsSubtotal(Array.isArray((q as any)?.items) ? (q as any).items : [])
  const tax = sumLineItemsTax(Array.isArray((q as any)?.items) ? (q as any).items : [], rate)
  return subtotal + tax
}

export async function processSalesReminders() {
  const now = new Date()
  const today = ymdLocal(now)

  const reminderSettings = await (prisma as any).salesReminderSettings
    .findUnique({ where: { id: 'default' } })
    .catch(() => null)

  const overdueEnabled = Boolean(reminderSettings?.overdueInvoiceRemindersEnabled)
  const overdueDays = Number.isFinite(Number(reminderSettings?.overdueInvoiceBusinessDaysAfterDue))
    ? Math.max(1, Math.trunc(Number(reminderSettings.overdueInvoiceBusinessDaysAfterDue)))
    : 3

  const quoteExpiryEnabled = Boolean(reminderSettings?.quoteExpiryRemindersEnabled)
  const quoteExpiryDays = Number.isFinite(Number(reminderSettings?.quoteExpiryBusinessDaysBeforeValidUntil))
    ? Math.max(1, Math.trunc(Number(reminderSettings.quoteExpiryBusinessDaysBeforeValidUntil)))
    : 3

  if (!overdueEnabled && !quoteExpiryEnabled) return

  const settingsRow = await prisma.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  }).catch(() => null)

  const settings: SalesSettings = settingsRow ? salesSettingsFromDb(settingsRow as any) : ({} as SalesSettings)

  const invoiceRows = await prisma.salesInvoice.findMany({
    where: { dueDate: { not: null }, remindersEnabled: true },
    take: 5000,
  }).catch(() => [])

  const quoteRows = await prisma.salesQuote.findMany({
    where: { validUntil: { not: null }, remindersEnabled: true },
    take: 5000,
  }).catch(() => [])

  const invoices: SalesInvoice[] = invoiceRows.map((r: any) => salesInvoiceFromDb(r as any))
  const quotes: SalesQuote[] = quoteRows.map((r: any) => salesQuoteFromDb(r as any))

  const emailSettings = await getEmailSettings()
  const fromAddress = emailSettings.smtpFromAddress || emailSettings.smtpUsername || 'noreply@vitransfer.com'
  const companyName = (emailSettings.companyName || 'Studio').trim() || 'Studio'

  const appBaseUrl =
    safeOriginFromUrl(process.env.NEXT_PUBLIC_APP_URL) ||
    safeOriginFromUrl(emailSettings.appDomain) ||
    safeOriginFromUrl(process.env.APP_DOMAIN) ||
    ''

  const companyLogoUrl = buildCompanyLogoUrl({
    appDomain: emailSettings.appDomain,
    companyLogoMode: emailSettings.companyLogoMode,
    companyLogoPath: emailSettings.companyLogoPath,
    companyLogoUrl: emailSettings.companyLogoUrl,
    updatedAt: emailSettings.updatedAt,
  })

  const trackingPixelsEnabled = emailSettings.emailTrackingPixelsEnabled ?? true

  const stripeGateway = await prisma.salesStripeGatewaySettings.findUnique({
    where: { id: 'default' },
    // NOTE: feeFixedCents is newer; cast for older generated prisma client types.
    select: { enabled: true, feePercent: true, feeFixedCents: true, currencies: true } as any,
  } as any).catch(() => null)

  const invoiceIds = invoices.map((i) => i.id).filter((id) => typeof id === 'string' && id.trim())
  const stripePayments = invoiceIds.length
    ? await prisma.salesInvoiceStripePayment.findMany({
        where: { invoiceDocId: { in: invoiceIds } },
        select: { invoiceDocId: true, invoiceAmountCents: true, createdAt: true },
        take: 2000,
      }).catch(() => [])
    : []

  const stripePaidByInvoiceId: Record<string, { paidCents: number; latestYmd: string | null }> = {}
  for (const p of stripePayments) {
    const id = (p as any)?.invoiceDocId
    const amount = Number((p as any)?.invoiceAmountCents)
    if (typeof id !== 'string' || !id.trim() || !Number.isFinite(amount)) continue
    const paidCents = Math.max(0, Math.trunc(amount))
    const createdIso = typeof (p as any)?.createdAt === 'string' ? (p as any).createdAt : (p as any)?.createdAt?.toISOString?.()
    const ymd = typeof createdIso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(createdIso) ? createdIso.slice(0, 10) : null

    const base = stripePaidByInvoiceId[id] ?? { paidCents: 0, latestYmd: null }
    const latestYmd = [base.latestYmd, ymd]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .sort()
      .at(-1)
      ?? null
    stripePaidByInvoiceId[id] = { paidCents: base.paidCents + paidCents, latestYmd }
  }

  void today

  async function getRecipientEmailsForClient(clientId: string): Promise<string[]> {
    const list = await (prisma as any).clientRecipient
      .findMany({
        where: { clientId, receiveSalesReminders: true },
        select: { email: true },
      })
      .catch(() => [])

    const set = new Set<string>()
    for (const r of list) {
      const e = (typeof r?.email === 'string' ? r.email : '').trim()
      if (e.includes('@')) set.add(e)
    }

    return Array.from(set)
  }

  async function upsertSalesShare(input: {
    type: 'QUOTE' | 'INVOICE'
    doc: any
    settings: any
    clientName: string | null
    projectTitle: string | null
    clientAddress: string | null
  }): Promise<{ token: string; url: string | null } | null> {
    if (!appBaseUrl) return null

    const docId = String(input.doc.id)
    const docNumber = input.type === 'QUOTE' ? String(input.doc.quoteNumber || '') : String(input.doc.invoiceNumber || '')
    if (!docNumber.trim()) return null

    const docSnapshot = input.clientAddress
      ? { ...input.doc, clientAddress: input.clientAddress }
      : input.doc

    const expiresAt = input.type === 'QUOTE'
      ? computeQuoteShareExpiresAt(typeof input.doc?.validUntil === 'string' ? input.doc.validUntil : null)
      : null

    const existing = await prisma.salesDocumentShare.findUnique({
      where: { type_docId: { type: input.type, docId } },
      select: { token: true, revokedAt: true },
    }).catch(() => null)

    let token = existing?.token
    if (!token || existing?.revokedAt) token = randomToken()

    const record = await prisma.salesDocumentShare.upsert({
      where: { type_docId: { type: input.type, docId } },
      create: {
        token,
        type: input.type,
        docId,
        docNumber,
        docJson: docSnapshot as any,
        settingsJson: input.settings as any,
        clientName: input.clientName,
        projectTitle: input.projectTitle,
        expiresAt,
      },
      update: {
        token,
        docNumber,
        docJson: docSnapshot as any,
        settingsJson: input.settings as any,
        clientName: input.clientName,
        projectTitle: input.projectTitle,
        expiresAt,
        revokedAt: null,
      },
      select: { token: true },
    })

    return { token: record.token, url: `${appBaseUrl}/sales/view/${encodeURIComponent(record.token)}` }
  }

  // Overdue invoice reminders
  if (overdueEnabled) {
    for (let i = 0; i < invoices.length; i++) {
      const inv: any = invoices[i]
      const enabled = inv?.remindersEnabled !== false
      if (!enabled) continue

      const dueYmd = typeof inv?.dueDate === 'string' ? inv.dueDate : null
      if (!dueYmd) continue

      const dueDate = parseYmd(dueYmd)
      if (!dueDate) continue

      // Must be overdue now
      if (now.getTime() <= endOfDayLocal(dueDate).getTime()) continue

      const triggerYmd = addBusinessDaysYmd(dueYmd, overdueDays)
      if (!triggerYmd || triggerYmd !== today) continue

      if (typeof inv?.lastOverdueReminderSentYmd === 'string' && inv.lastOverdueReminderSentYmd === today) continue

      const clientId = typeof inv?.clientId === 'string' ? inv.clientId : ''
      if (!clientId) continue

      const recipientEmails = await getRecipientEmailsForClient(clientId)
      if (!recipientEmails.length) continue

      const client = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null },
        select: { name: true, address: true },
      }).catch(() => null)

      const projectId = typeof inv?.projectId === 'string' ? inv.projectId : ''
      const project = projectId
        ? await prisma.project.findFirst({ where: { id: projectId }, select: { title: true } }).catch(() => null)
        : null

      const share = await upsertSalesShare({
        type: 'INVOICE',
        doc: inv,
        settings,
        clientName: client?.name ?? null,
        projectTitle: project?.title ?? null,
        clientAddress: client?.address ? String(client.address).trim() : null,
      })
      if (!share?.url) continue

      const totalCents = invoiceTotalCents(inv as SalesInvoice, settings)

      const pdfInfo: PdfPartyInfo = {
        clientName: client?.name ?? undefined,
        clientAddress: client?.address ? String(client.address).trim() : undefined,
        projectTitle: project?.title ?? undefined,
        publicInvoiceUrl: share.url,
      }

      if (stripeGateway?.enabled) {
        const currency = firstCurrencyFromCsv(stripeGateway?.currencies)
        const feePercent = Number(stripeGateway?.feePercent ?? 0)
        const feeFixedCents = Number((stripeGateway as any)?.feeFixedCents ?? 0)
        const feeCents = calcStripeGrossUpCents(totalCents, feePercent, feeFixedCents).feeCents
        pdfInfo.stripeProcessingFeeCents = feeCents
        pdfInfo.stripeProcessingFeeCurrency = currency
      }

      let pdfBytes: Uint8Array
      try {
        pdfBytes = await renderInvoicePdfBytes(inv as SalesInvoice, settings, pdfInfo, { baseUrl: appBaseUrl })
      } catch {
        continue
      }

      const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
      const cardStyle = emailCardStyle({ borderRadiusPx: 8 })

      const html = renderEmailShell({
        companyName,
        companyLogoUrl,
        headerGradient: EMAIL_THEME.headerBackground,
        title: 'Invoice overdue',
        subtitle: client?.name ? `For ${escapeHtml(client.name)}` : undefined,
        trackingPixelsEnabled,
        appDomain: emailSettings.appDomain || appBaseUrl,
        bodyContent: `
          <p style="margin: 0 0 16px 0; font-size: 15px; color: #111827; line-height: 1.6;">
            Hi,
          </p>

          <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
            Just a friendly reminder that <strong>Invoice ${escapeHtml(String(inv.invoiceNumber || ''))}</strong> is overdue.
          </p>

          <div style="${cardStyle}">
            <div style="font-size: 15px; color: #111827; padding: 4px 0;">
              <strong>Invoice ${escapeHtml(String(inv.invoiceNumber || ''))}</strong>
            </div>
            ${project?.title ? `<div style="font-size: 14px; color: #374151; padding: 2px 0;">Project: ${escapeHtml(project.title)}</div>` : ''}
            <div style="font-size: 14px; color: #374151; padding: 2px 0;">Due date: ${escapeHtml(String(dueYmd))}</div>
          </div>

          <div style="text-align: center; margin: 28px 0;">
            <a href="${escapeHtml(share.url)}" style="${primaryButtonStyle}">View Invoice</a>
          </div>

          <p style="margin: 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
            If the button doesn’t work, copy and paste this link into your browser:<br />
            <a href="${escapeHtml(share.url)}" style="color: ${EMAIL_THEME.accent}; text-decoration: none;">${escapeHtml(share.url)}</a>
          </p>
        `,
      })

      const sendResult = await sendEmail({
        to: fromAddress,
        bcc: recipientEmails,
        subject: `Invoice ${String(inv.invoiceNumber || '')} is overdue`,
        html,
        attachments: [
          {
            filename: `${String(inv.invoiceNumber || 'invoice')}.pdf`,
            content: Buffer.from(pdfBytes),
            contentType: 'application/pdf',
          },
        ],
      })

      if (!sendResult.success) continue

      try {
        await prisma.salesInvoice.update({
          where: { id: String(inv.id) },
          data: { lastOverdueReminderSentYmd: today },
          select: { id: true },
        })
      } catch {
        // Best-effort. If we fail to mark it, the next run may resend.
      }
    }
  }

  // Quote expiry reminders
  if (quoteExpiryEnabled) {
    for (let i = 0; i < quotes.length; i++) {
      const q: any = quotes[i]
      const enabled = q?.remindersEnabled !== false
      if (!enabled) continue

      if (q?.status === 'ACCEPTED' || q?.status === 'CLOSED') continue

      const validUntil = typeof q?.validUntil === 'string' ? q.validUntil : null
      if (!validUntil) continue

      const until = parseYmd(validUntil)
      if (!until) continue

      // Ignore expired quotes
      if (now.getTime() > endOfDayLocal(until).getTime()) continue

      const triggerYmd = subBusinessDaysYmd(validUntil, quoteExpiryDays)
      if (!triggerYmd || triggerYmd !== today) continue

      if (typeof q?.lastExpiryReminderSentYmd === 'string' && q.lastExpiryReminderSentYmd === today) continue

      const clientId = typeof q?.clientId === 'string' ? q.clientId : ''
      if (!clientId) continue

      const recipientEmails = await getRecipientEmailsForClient(clientId)
      if (!recipientEmails.length) continue

      const client = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null },
        select: { name: true, address: true },
      }).catch(() => null)

      const projectId = typeof q?.projectId === 'string' ? q.projectId : ''
      const project = projectId
        ? await prisma.project.findFirst({ where: { id: projectId }, select: { title: true } }).catch(() => null)
        : null

      const share = await upsertSalesShare({
        type: 'QUOTE',
        doc: q,
        settings,
        clientName: client?.name ?? null,
        projectTitle: project?.title ?? null,
        clientAddress: client?.address ? String(client.address).trim() : null,
      })
      if (!share?.url) continue

      const totalCents = quoteTotalCents(q as SalesQuote, settings)
      void totalCents

      const pdfInfo: PdfPartyInfo = {
        clientName: client?.name ?? undefined,
        clientAddress: client?.address ? String(client.address).trim() : undefined,
        projectTitle: project?.title ?? undefined,
        publicQuoteUrl: share.url,
      }

      let pdfBytes: Uint8Array
      try {
        pdfBytes = await renderQuotePdfBytes(q as SalesQuote, settings, pdfInfo, { baseUrl: appBaseUrl })
      } catch {
        continue
      }

      const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
      const cardStyle = emailCardStyle({ borderRadiusPx: 8 })

      const html = renderEmailShell({
        companyName,
        companyLogoUrl,
        headerGradient: EMAIL_THEME.headerBackground,
        title: 'Quote expiring soon',
        subtitle: client?.name ? `For ${escapeHtml(client.name)}` : undefined,
        trackingPixelsEnabled,
        appDomain: emailSettings.appDomain || appBaseUrl,
        bodyContent: `
          <p style="margin: 0 0 16px 0; font-size: 15px; color: #111827; line-height: 1.6;">
            Hi,
          </p>

          <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
            Just a friendly reminder that <strong>Quote ${escapeHtml(String(q.quoteNumber || ''))}</strong> expires on <strong>${escapeHtml(String(validUntil))}</strong>.
          </p>

          <div style="${cardStyle}">
            <div style="font-size: 15px; color: #111827; padding: 4px 0;">
              <strong>Quote ${escapeHtml(String(q.quoteNumber || ''))}</strong>
            </div>
            ${project?.title ? `<div style="font-size: 14px; color: #374151; padding: 2px 0;">Project: ${escapeHtml(project.title)}</div>` : ''}
            <div style="font-size: 14px; color: #374151; padding: 2px 0;">Valid until: ${escapeHtml(String(validUntil))}</div>
          </div>

          <div style="text-align: center; margin: 28px 0;">
            <a href="${escapeHtml(share.url)}" style="${primaryButtonStyle}">View Quote</a>
          </div>

          <p style="margin: 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
            If the button doesn’t work, copy and paste this link into your browser:<br />
            <a href="${escapeHtml(share.url)}" style="color: ${EMAIL_THEME.accent}; text-decoration: none;">${escapeHtml(share.url)}</a>
          </p>
        `,
      })

      const sendResult = await sendEmail({
        to: fromAddress,
        bcc: recipientEmails,
        subject: `Quote ${String(q.quoteNumber || '')} expiring soon`,
        html,
        attachments: [
          {
            filename: `${String(q.quoteNumber || 'quote')}.pdf`,
            content: Buffer.from(pdfBytes),
            contentType: 'application/pdf',
          },
        ],
      })

      if (!sendResult.success) continue

      try {
        await prisma.salesQuote.update({
          where: { id: String(q.id) },
          data: { lastExpiryReminderSentYmd: today },
          select: { id: true },
        })
      } catch {
        // Best-effort. If we fail to mark it, the next run may resend.
      }
    }
  }
}
