import { notFound } from 'next/navigation'
import Image from 'next/image'
import { headers } from 'next/headers'
import { prisma } from '@/lib/db'
import { calcLineSubtotalCents, calcLineTaxCents, centsToDollars, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { calcStripeGrossUpCents } from '@/lib/sales/stripe-fees'
import PublicSalesDocActions from './public-sales-doc-actions'
import { getSecuritySettings } from '@/lib/video-access'
import { sendPushNotification } from '@/lib/push-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function generateMetadata(
  _props: { params: Promise<{ token: string }> }
) {
  return {
    robots: { index: false, follow: false },
  }
}

type DocType = 'QUOTE' | 'INVOICE'

type QuoteStatus = 'OPEN' | 'SENT' | 'CLOSED' | 'ACCEPTED'
type InvoiceStatus = 'OPEN' | 'SENT' | 'OVERDUE' | 'PARTIALLY_PAID' | 'PAID'

function quoteStatusBadgeClass(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'ACCEPTED':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
    case 'CLOSED':
      return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/20'
  }
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'ACCEPTED':
      return 'Accepted'
    case 'CLOSED':
      return 'Closed'
  }
}

function invoiceStatusBadgeClass(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'OVERDUE':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20'
    case 'PARTIALLY_PAID':
      return 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20'
    case 'PAID':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
  }
}

function invoiceStatusLabel(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'OVERDUE':
      return 'Overdue'
    case 'PARTIALLY_PAID':
      return 'Partially Paid'
    case 'PAID':
      return 'Paid'
  }
}

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstCurrencyFromCsv(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const first = raw.split(',')[0]?.trim().toUpperCase()
  return first && /^[A-Z]{3}$/.test(first) ? first : 'AUD'
}

function getClientIpFromHeaders(h: Headers): string | null {
  const forwarded = h.get('x-forwarded-for')
  const ip = (forwarded ? forwarded.split(',')[0] : h.get('x-real-ip'))
  const trimmed = typeof ip === 'string' ? ip.trim() : ''
  return trimmed || null
}

function hasConfiguredLogo(settings: { companyLogoPath: string | null; companyLogoMode: string | null; companyLogoUrl: string | null } | null): boolean {
  if (!settings) return false
  if (settings.companyLogoPath) return true
  const mode = typeof settings.companyLogoMode === 'string' ? settings.companyLogoMode : ''
  const url = typeof settings.companyLogoUrl === 'string' ? settings.companyLogoUrl.trim() : ''
  return mode === 'LINK' && Boolean(url)
}

export default async function SalesDocPublicViewPage(
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  if (!token) return notFound()

  const shares = await prisma.$queryRaw<any[]>`
    SELECT *
    FROM "SalesDocumentShare"
    WHERE "token" = ${token}
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
    LIMIT 1
  `

  const share = shares?.[0]
  if (!share) return notFound()

  // Track access (best-effort)
  await prisma.salesDocumentShare.update({
    where: { token },
    data: { lastAccessedAt: new Date() },
  }).catch(() => {})

  // Track view event + push notification (best-effort)
  const security = await getSecuritySettings().catch(() => null)
  if (security?.trackAnalytics) {
    const h = await headers()
    const ipAddress = getClientIpFromHeaders(h)
    const userAgent = h.get('user-agent') || null

    await prisma.salesDocumentViewEvent.create({
      data: {
        shareToken: token,
        type: share.type,
        docId: String(share.docId || ''),
        ipAddress,
        userAgent,
      },
    }).catch(() => {})

    const isQuote = String(share.type) === 'QUOTE'
    const notifType = isQuote ? 'SALES_QUOTE_VIEWED' : 'SALES_INVOICE_VIEWED'
    const docNumber = String(share.docNumber || '')

    await sendPushNotification({
      type: notifType as any,
      title: isQuote ? 'Quote Viewed' : 'Invoice Viewed',
      message: `A client viewed the ${isQuote ? 'quote' : 'invoice'} link`,
      details: {
        'Number': docNumber,
        'Client': share.clientName || undefined,
        'Project': share.projectTitle || undefined,
        'IP Address': ipAddress || undefined,
      },
    }).catch(() => {})
  }

  const type = share.type as DocType
  const doc = share.docJson as any
  const settings = share.settingsJson as any

  const stripeGateway = await prisma.salesStripeGatewaySettings.findUnique({
    where: { id: 'default' },
    select: { enabled: true, label: true, currencies: true, feePercent: true, feeFixedCents: true },
  }).catch(() => null)

  const logoSettings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { companyLogoPath: true, companyLogoMode: true, companyLogoUrl: true },
  })
  const showLogo = hasConfiguredLogo(logoSettings)

  const businessName = safeString(settings?.businessName) || 'Business'
  const address = safeString(settings?.address)
  const phone = safeString(settings?.phone)
  const email = safeString(settings?.email)
  const website = safeString(settings?.website)
  const abn = safeString(settings?.abn)
  const paymentDetails = safeString(settings?.paymentDetails)
  const taxRatePercent = Number(settings?.taxRatePercent)
  const defaultTaxRatePercent = Number.isFinite(taxRatePercent) ? taxRatePercent : 10

  const items = Array.isArray(doc?.items) ? doc.items : []
  const subtotalCents = sumLineItemsSubtotal(items)
  const taxCents = sumLineItemsTax(items, defaultTaxRatePercent)
  const totalCents = subtotalCents + taxCents

  const issueDate = safeString(doc?.issueDate)
  const dueOrExpiry = type === 'INVOICE' ? safeString(doc?.dueDate) : safeString(doc?.validUntil)

  const title = type === 'INVOICE' ? 'INVOICE' : 'QUOTE'
  const numberLabel = type === 'INVOICE' ? 'Invoice #' : 'Quote #'
  const number = safeString(share.docNumber)

  const rawStatus = safeString(doc?.status).toUpperCase()
  const status = (type === 'QUOTE'
    ? (['OPEN', 'SENT', 'CLOSED', 'ACCEPTED'].includes(rawStatus) ? (rawStatus as QuoteStatus) : null)
    : (['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'].includes(rawStatus) ? (rawStatus as InvoiceStatus) : null)
  )

  const clientName = share.clientName || 'Client'
  const projectTitle = share.projectTitle

  let clientAddress = safeString(doc?.clientAddress)
  if (!clientAddress) {
    const clientId = safeString(doc?.clientId)
    if (clientId) {
      const client = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null },
        select: { address: true },
      })
      clientAddress = typeof client?.address === 'string' ? client.address : ''
    }
  }
  clientAddress = clientAddress.trim()

  const canAcceptQuote = type === 'QUOTE' && status === 'OPEN'
  const canPayInvoice = type === 'INVOICE'
    && Boolean(stripeGateway?.enabled)
    && rawStatus !== 'PAID'

  const displayCurrency = type === 'INVOICE'
    ? firstCurrencyFromCsv(stripeGateway?.currencies)
    : 'AUD'

  const processingFeeCents = (type === 'INVOICE' && canPayInvoice)
    ? calcStripeGrossUpCents(
        totalCents,
        Number(stripeGateway?.feePercent ?? 0),
        Number(stripeGateway?.feeFixedCents ?? 0)
      ).feeCents
    : null

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:py-10">
        <div className="mb-3">
          <PublicSalesDocActions
            token={token}
            type={type}
            doc={doc}
            settings={settings}
            clientName={clientName}
            clientAddress={clientAddress || undefined}
            projectTitle={projectTitle}
            canAcceptQuote={canAcceptQuote}
            canPayInvoice={canPayInvoice}
            payLabel={stripeGateway?.label ?? null}
            processingFeeCents={processingFeeCents}
            processingFeeCurrency={displayCurrency}
          />
        </div>
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="bg-foreground text-background px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {showLogo && (
                  <div className="mb-3">
                    <Image
                      src="/api/branding/logo"
                      alt="Company logo"
                      width={240}
                      height={80}
                      className="h-10 w-auto object-contain"
                      priority
                    />
                  </div>
                )}
                <div className="text-lg font-semibold break-words">{businessName}</div>
                {abn && <div className="text-xs opacity-80 mt-0.5">ABN: {abn}</div>}
                {address && (
                  <div className="text-xs opacity-80 mt-2 whitespace-pre-wrap">{address}</div>
                )}
                <div className="text-xs opacity-80 mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {phone && <span>Phone: {phone}</span>}
                  {email && <span>Email: {email}</span>}
                  {website && <span>Web: {website}</span>}
                </div>
              </div>

              <div className="text-right flex-shrink-0">
                <div className="text-2xl font-bold tracking-wide">{title}</div>
                <div className="text-sm opacity-90 mt-1">{numberLabel} {number}</div>
                {status && (
                  <div className="mt-2">
                    <span
                      className={
                        `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
                          type === 'QUOTE'
                            ? quoteStatusBadgeClass(status as QuoteStatus)
                            : invoiceStatusBadgeClass(status as InvoiceStatus)
                        }`
                      }
                    >
                      {type === 'QUOTE'
                        ? quoteStatusLabel(status as QuoteStatus)
                        : invoiceStatusLabel(status as InvoiceStatus)}
                    </span>
                  </div>
                )}
                {issueDate && <div className="text-xs opacity-80 mt-2">Issue: {issueDate}</div>}
                {dueOrExpiry && <div className="text-xs opacity-80">{type === 'INVOICE' ? 'Due' : 'Expiry'}: {dueOrExpiry}</div>}
              </div>
            </div>
          </div>

          <div className="px-6 py-6 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground">Bill To</div>
                <div className="text-sm font-medium mt-1 break-words">{clientName}</div>
                {clientAddress && (
                  <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words">{clientAddress}</div>
                )}
                {projectTitle && (
                  <div className="text-xs text-muted-foreground mt-1 break-words">Project: {projectTitle}</div>
                )}
              </div>
              <div className="text-sm text-muted-foreground sm:text-right">
                <div className="text-xs">Amounts in {displayCurrency}</div>
              </div>
            </div>

            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-foreground text-background">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold">Item</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold">Qty</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold">Rate</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold">Tax</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                        No line items
                      </td>
                    </tr>
                  ) : (
                    items.map((it: any, index: number) => {
                      const qty = Number(it?.quantity)
                      const unit = Number(it?.unitPriceCents)
                      const ratePercent = Number(it?.taxRatePercent)
                      const itemTaxRatePercent = Number.isFinite(ratePercent) ? ratePercent : defaultTaxRatePercent

                      const lineSubtotal = calcLineSubtotalCents({
                        id: safeString(it?.id) || 'li',
                        description: safeString(it?.description),
                        details: safeString(it?.details) || undefined,
                        quantity: Number.isFinite(qty) ? qty : 0,
                        unitPriceCents: Number.isFinite(unit) ? unit : 0,
                        taxRatePercent: itemTaxRatePercent,
                      })
                      const lineTax = calcLineTaxCents(
                        {
                          id: safeString(it?.id) || 'li',
                          description: safeString(it?.description),
                          details: safeString(it?.details) || undefined,
                          quantity: Number.isFinite(qty) ? qty : 0,
                          unitPriceCents: Number.isFinite(unit) ? unit : 0,
                          taxRatePercent: itemTaxRatePercent,
                        },
                        defaultTaxRatePercent
                      )
                      const lineTotal = lineSubtotal + lineTax

                      const key = safeString(it?.id) || `${index}-${safeString(it?.description)}`

                      return (
                        <tr key={key} className="border-t">
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium break-words">{safeString(it?.description) || '—'}</div>
                            {safeString(it?.details).trim() && (
                              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-1">
                                {safeString(it?.details)}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums align-top">{Number.isFinite(qty) ? qty : 0}</td>
                          <td className="px-3 py-2 text-right tabular-nums align-top">${centsToDollars(Number.isFinite(unit) ? unit : 0)}</td>
                          <td className="px-3 py-2 text-right tabular-nums align-top">${centsToDollars(lineTax)}</td>
                          <td className="px-3 py-2 text-right tabular-nums align-top font-medium">${centsToDollars(lineTotal)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <div className="w-full sm:w-[320px] space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">${centsToDollars(subtotalCents)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="tabular-nums">${centsToDollars(taxCents)}</span>
                </div>
                <div className="flex justify-between border-t pt-2">
                  <span className="font-semibold">Total</span>
                  <span className="font-semibold tabular-nums">${centsToDollars(totalCents)}</span>
                </div>
              </div>
            </div>

            {(safeString(doc?.notes).trim() || safeString(doc?.terms).trim() || (type === 'INVOICE' && paymentDetails.trim())) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {(safeString(doc?.notes).trim() || safeString(doc?.terms).trim()) ? (
                  <div>
                    {safeString(doc?.notes).trim() && (
                      <>
                        <div className="text-xs text-muted-foreground">Notes</div>
                        <div className="text-sm whitespace-pre-wrap break-words mt-1">{safeString(doc?.notes)}</div>
                      </>
                    )}
                    {safeString(doc?.terms).trim() && (
                      <>
                        <div className={safeString(doc?.notes).trim() ? 'text-xs text-muted-foreground mt-4' : 'text-xs text-muted-foreground'}>Terms</div>
                        <div className="text-sm whitespace-pre-wrap break-words mt-1">{safeString(doc?.terms)}</div>
                      </>
                    )}
                  </div>
                ) : (
                  <div />
                )}

                {type === 'INVOICE' && paymentDetails.trim() && (
                  <div className="sm:text-right">
                    <div className="text-xs text-muted-foreground">Payment details</div>
                    <div className="text-sm whitespace-pre-wrap break-words mt-1">{paymentDetails}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
