import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import {
  EMAIL_THEME,
  buildCompanyLogoUrl,
  emailCardStyle,
  emailPrimaryButtonStyle,
  escapeHtml,
  firstWordName,
  getEmailSettings,
  renderEmailShell,
  sendEmail,
} from '@/lib/email'
import { salesSettingsFromDb } from '@/lib/sales/db-mappers'
import { renderInvoicePdfBytes, renderQuotePdfBytes } from '@/lib/sales/pdf'
import type { PdfPartyInfo } from '@/lib/sales/pdf'
import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { calcStripeGrossUpCents } from '@/lib/sales/stripe-fees'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  shareToken: z.string().min(10),
  toEmails: z.array(z.string().trim().max(320).email()).min(1).max(25),
  notes: z.string().trim().max(5000).optional().nullable(),
})

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function normalizeBaseUrl(input: string | null | undefined): string | null {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return null
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return url.origin
  } catch {
    return null
  }
}

function firstCurrencyFromCsv(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const first = raw.split(',')[0]?.trim().toUpperCase()
  return first && /^[A-Z]{3}$/.test(first) ? first : 'AUD'
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-sales-send-email',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { shareToken, toEmails, notes } = parsed.data

  const share = await prisma.salesDocumentShare.findUnique({
    where: { token: shareToken },
    select: {
      token: true,
      type: true,
      docId: true,
      docNumber: true,
      docJson: true,
      settingsJson: true,
      clientName: true,
      projectTitle: true,
      expiresAt: true,
      revokedAt: true,
    },
  })

  if (!share || share.revokedAt || (share.expiresAt && share.expiresAt <= new Date())) {
    return NextResponse.json({ error: 'Share link is not available' }, { status: 404 })
  }

  const emailSettings = await getEmailSettings()
  const appBaseUrl = normalizeBaseUrl(emailSettings.appDomain) || new URL(request.url).origin
  const shareUrl = `${appBaseUrl}/sales/view/${encodeURIComponent(share.token)}`

  const companyName = (emailSettings.companyName || 'Studio').trim() || 'Studio'
  const companyLogoUrl = buildCompanyLogoUrl({
    appDomain: emailSettings.appDomain,
    companyLogoMode: emailSettings.companyLogoMode,
    companyLogoPath: emailSettings.companyLogoPath,
    companyLogoUrl: emailSettings.companyLogoUrl,
    updatedAt: emailSettings.updatedAt,
  })

  const trackingPixelsEnabled = emailSettings.emailTrackingPixelsEnabled ?? true

  const isQuote = share.type === 'QUOTE'
  const docLabel = isQuote ? 'Quote' : 'Invoice'
  const subject = `${docLabel} ${share.docNumber}`

  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })

  const doc = share.docJson as unknown as SalesQuote | SalesInvoice
  const liveSettingsRow = await prisma.salesSettings
    .upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} })
    .catch(() => null)
  const settings = (liveSettingsRow
    ? salesSettingsFromDb(liveSettingsRow as any)
    : (share.settingsJson as unknown as SalesSettings)
  )

  const stripeGateway = await prisma.salesStripeGatewaySettings.findUnique({
    where: { id: 'default' },
    select: { enabled: true, feePercent: true, feeFixedCents: true, currencies: true },
  }).catch(() => null)

  const docAny: any = doc as any
  const clientId = typeof docAny?.clientId === 'string' ? docAny.clientId.trim() : ''

  let liveClientName: string | undefined
  let liveClientAddress: string | undefined
  if (clientId) {
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { name: true, address: true },
    }).catch(() => null)

    if (typeof client?.name === 'string' && client.name.trim()) {
      liveClientName = client.name.trim()
    }
    if (typeof client?.address === 'string' && client.address.trim()) {
      liveClientAddress = client.address.trim()
    }
  }

  const addressFromDoc = typeof docAny?.clientAddress === 'string' ? docAny.clientAddress.trim() : ''
  const clientAddress = liveClientAddress || (addressFromDoc ? addressFromDoc : undefined)

  const pdfInfo: PdfPartyInfo = {
    clientName: liveClientName || share.clientName || undefined,
    clientAddress,
    projectTitle: share.projectTitle || undefined,
    publicQuoteUrl: isQuote ? shareUrl : undefined,
    publicInvoiceUrl: !isQuote ? shareUrl : undefined,
  }

  if (!isQuote && stripeGateway?.enabled) {
    const inv = doc as SalesInvoice
    const taxRatePercent = Number((settings as any)?.taxRatePercent)
    const defaultTaxRate = Number.isFinite(taxRatePercent) ? taxRatePercent : 10
    const items = Array.isArray((inv as any)?.items) ? (inv as any).items : []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = sumLineItemsTax(items, defaultTaxRate)
    const totalCents = subtotalCents + taxCents

    const currency = firstCurrencyFromCsv(stripeGateway?.currencies)
    const feePercent = Number(stripeGateway?.feePercent ?? 0)
    const feeFixedCents = Number(stripeGateway?.feeFixedCents ?? 0)

    const feeCents = calcStripeGrossUpCents(totalCents, feePercent, feeFixedCents).feeCents
    pdfInfo.stripeProcessingFeeCents = feeCents
    pdfInfo.stripeProcessingFeeCurrency = currency
  }

  let pdfBytes: Uint8Array
  try {
    pdfBytes = isQuote
      ? await renderQuotePdfBytes(doc as SalesQuote, settings, pdfInfo, { baseUrl: appBaseUrl })
      : await renderInvoicePdfBytes(doc as SalesInvoice, settings, pdfInfo, { baseUrl: appBaseUrl })
  } catch (e) {
    console.error('Failed to generate PDF bytes:', e)
    return NextResponse.json({ error: 'Failed to generate PDF attachment' }, { status: 500 })
  }

  const pdfAttachment = {
    filename: `${share.docNumber}.pdf`,
    content: Buffer.from(pdfBytes),
    contentType: 'application/pdf',
  } as const

  const uniqueToEmails = Array.from(
    new Set(
      toEmails
        .map((e) => (typeof e === 'string' ? e.trim() : ''))
        .filter(Boolean)
    )
  )
  if (!uniqueToEmails.length) {
    return NextResponse.json({ error: 'Please select at least one recipient' }, { status: 400 })
  }

  const recipientNameByEmail = new Map<string, string>()
  if (clientId) {
    const wantedEmails = new Set(uniqueToEmails.map((e) => e.toLowerCase()))
    const recipients = await prisma.clientRecipient.findMany({
      where: { clientId },
      select: { email: true, name: true },
    }).catch(() => [])

    for (const r of recipients) {
      const email = (typeof r?.email === 'string' ? r.email : '').trim().toLowerCase()
      const name = (typeof r?.name === 'string' ? r.name : '').trim()
      if (email && name && wantedEmails.has(email)) recipientNameByEmail.set(email, name)
    }
  }

  const sendErrors: Array<{ to: string; error: string }> = []
  let sentCount = 0

  const stripePaymentsEnabled = Boolean(stripeGateway?.enabled)

  for (const toEmail of uniqueToEmails) {
    // Generate a token for the email open tracking pixel.
    const trackingToken = randomToken()

    const emailLower = toEmail.toLowerCase()
    const nameFromDb = recipientNameByEmail.get(emailLower)
    const fallback = toEmail.split('@')[0] || 'there'
    const recipientName = firstWordName(nameFromDb) || firstWordName(fallback) || fallback

    const introLine = isQuote
      ? 'Please find the attached Quote. You can also view and accept the quote using the link below.'
      : stripePaymentsEnabled
        ? 'Please find the attached Invoice. You can also view and pay the invoice using the link below.'
        : 'Please find the attached Invoice. You can also view the invoice using the link below.'

    const html = renderEmailShell({
      companyName,
      companyLogoUrl,
      headerGradient: EMAIL_THEME.headerBackground,
      title: `${docLabel} ready`,
      subtitle: share.clientName ? `For ${escapeHtml(share.clientName)}` : undefined,
      trackingToken,
      trackingPixelsEnabled,
      trackingPixelPath: '/api/track/sales-email',
      appDomain: emailSettings.appDomain || appBaseUrl,
      bodyContent: `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #111827; line-height: 1.6;">
        Hi <strong>${escapeHtml(recipientName)}</strong>,
      </p>

      <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        ${escapeHtml(introLine)}
      </p>

      <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        If you have any questions, please don't hesitate to get in touch.
      </p>

      <div style="${cardStyle}">
        <div style="font-size: 15px; color: #111827; padding: 4px 0;">
          <strong>${escapeHtml(docLabel)} ${escapeHtml(String(share.docNumber || ''))}</strong>
        </div>
        ${share.projectTitle ? `
          <div style="font-size: 14px; color: #374151; padding: 2px 0;">
            Project: ${escapeHtml(share.projectTitle)}
          </div>
        ` : ''}
      </div>

      ${notes ? `
        <div style="${cardStyle}">
          <div style="font-size: 14px; color: #111827; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(notes)}</div>
        </div>
      ` : ''}

      <div style="text-align: center; margin: 28px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View ${escapeHtml(docLabel)}
        </a>
      </div>

      <p style="margin: 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        If the button doesn’t work, copy and paste this link into your browser:<br />
        <a href="${escapeHtml(shareUrl)}" style="color: ${EMAIL_THEME.accent}; text-decoration: none;">${escapeHtml(shareUrl)}</a>
      </p>
    `,
    })

    const sendResult = await sendEmail({
      to: toEmail,
      subject,
      html,
      attachments: [pdfAttachment],
    })

    if (!sendResult.success) {
      sendErrors.push({ to: toEmail, error: sendResult.error || 'Failed to send email' })
      continue
    }

    sentCount += 1

    // Record the email for tracking in the DB after successful send.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await prisma.salesEmailTracking.create({
          data: {
            token: attempt === 0 ? trackingToken : randomToken(),
            shareToken: share.token,
            type: share.type,
            docId: String(share.docId),
            recipientEmail: toEmail,
          },
        })
        break
      } catch (e: any) {
        if (e?.code === 'P2002') continue
        throw e
      }
    }
  }

  if (sendErrors.length) {
    if (!sentCount) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to send email',
          sentCount,
          failed: sendErrors,
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true, sentCount, failed: sendErrors })
  }

  return NextResponse.json({ ok: true, sentCount })
}
