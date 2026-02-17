import { notFound } from 'next/navigation'
import Image from 'next/image'
import { headers } from 'next/headers'
import { prisma } from '@/lib/db'
import { salesSettingsFromDb } from '@/lib/sales/db-mappers'
import type { SalesSettings } from '@/lib/sales/types'
import {
  invoiceStatusBadgeClass, invoiceStatusLabel,
  quoteStatusBadgeClass, quoteStatusLabel,
} from '@/lib/sales/badge'
import { calcLineSubtotalCents, calcLineTaxCents, centsToDollars, formatMoney, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { calcStripeGrossUpCents } from '@/lib/sales/stripe-fees'
import { getCurrencySymbol } from '@/lib/sales/currency'
import PublicSalesDocActions from './public-sales-doc-actions'
import { getSecuritySettings } from '@/lib/video-access'
import { sendPushNotification } from '@/lib/push-notifications'
import { formatDate } from '@/lib/utils'
import {
  invoiceEffectiveStatus as computeInvoiceEffectiveStatus,
  quoteEffectiveStatus as computeQuoteEffectiveStatus,
} from '@/lib/sales/status'

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

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstCurrencyFromCsv(value: unknown, fallback: string = 'AUD'): string {
  const raw = typeof value === 'string' ? value : ''
  const first = raw.split(',')[0]?.trim().toUpperCase()
  return first && /^[A-Z]{3}$/.test(first) ? first : fallback
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
    const docId = typeof (share as any)?.docId === 'string' ? String((share as any).docId) : null

    await sendPushNotification({
      type: notifType as any,
      title: isQuote ? 'Quote Viewed' : 'Invoice Viewed',
      message: `A client viewed the ${isQuote ? 'quote' : 'invoice'} link`,
      details: {
        ...(docId
          ? {
              salesDocType: isQuote ? 'QUOTE' : 'INVOICE',
              salesDocId: docId,
              __link: {
                href: isQuote
                  ? `/admin/sales/quotes/${encodeURIComponent(docId)}`
                  : `/admin/sales/invoices/${encodeURIComponent(docId)}`,
              },
            }
          : {}),
        'Number': docNumber,
        'Client': share.clientName || undefined,
        'Project': share.projectTitle || undefined,
        'IP Address': ipAddress || undefined,
      },
    }).catch(() => {})
  }

  const type = share.type as DocType
  const doc = share.docJson as any

  const liveSettingsRow = await prisma.salesSettings
    .upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} })
    .catch(() => null)
  const liveSettings = liveSettingsRow ? salesSettingsFromDb(liveSettingsRow as any) : null
  const settings = (liveSettings ?? (share.settingsJson as any) ?? {}) as Partial<SalesSettings>

  const stripeGateway = await prisma.salesStripeGatewaySettings.findUnique({
    where: { id: 'default' },
    select: { enabled: true, label: true, currencies: true, feePercent: true, feeFixedCents: true },
  }).catch(() => null)

  const logoSettings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      companyLogoPath: true, companyLogoMode: true, companyLogoUrl: true,
      darkLogoEnabled: true, darkLogoPath: true, darkLogoMode: true, darkLogoUrl: true,
    },
  })
  const showLogo = hasConfiguredLogo(logoSettings)

  // The invoice/quote header uses bg-foreground text-background, so it inverts
  // with the theme: dark surface in light mode, light surface in dark mode.
  // When a separate dark-mode logo exists we render both and CSS-toggle them:
  //   Light mode (dark header) → show dark logo   (dark:hidden)
  //   Dark mode (light header) → show normal logo (hidden dark:block)
  const hasDarkLogo = !!(logoSettings?.darkLogoEnabled && (
    logoSettings.darkLogoPath ||
    (logoSettings.darkLogoMode === 'LINK' && typeof logoSettings.darkLogoUrl === 'string' && logoSettings.darkLogoUrl.trim())
  ))

  const businessName = safeString(settings?.businessName) || 'Business'
  const address = safeString(settings?.address)
  const phone = safeString(settings?.phone)
  const email = safeString(settings?.email)
  const website = safeString(settings?.website)
  const abn = safeString(settings?.abn)
  const businessRegistrationLabel = safeString(settings?.businessRegistrationLabel) || 'ABN'
  const currencyCode = safeString(settings?.currencyCode) || 'AUD'
  const currencySymbol = getCurrencySymbol(currencyCode)
  const paymentDetails = safeString(settings?.paymentDetails)
  const taxRatePercent = Number(settings?.taxRatePercent)
  const defaultTaxRatePercent = Number.isFinite(taxRatePercent) ? taxRatePercent : 10
  // Use per-document taxEnabled (snapshot from creation); fall back to settings for legacy docs.
  const taxEnabled = typeof doc?.taxEnabled === 'boolean' ? doc.taxEnabled : (settings?.taxEnabled !== false)

  const items = Array.isArray(doc?.items) ? doc.items : []
  const subtotalCents = sumLineItemsSubtotal(items)
  const taxCents = taxEnabled ? sumLineItemsTax(items, defaultTaxRatePercent) : 0
  const totalCents = subtotalCents + taxCents

  const issueDate = safeString(doc?.issueDate) ? formatDate(safeString(doc?.issueDate)) : ''
  const dueOrExpiry = type === 'INVOICE' 
    ? (safeString(doc?.dueDate) ? formatDate(safeString(doc?.dueDate)) : '')
    : (safeString(doc?.validUntil) ? formatDate(safeString(doc?.validUntil)) : '')

  const title = type === 'INVOICE' ? (safeString(settings?.invoiceLabel) || 'INVOICE') : (safeString(settings?.quoteLabel) || 'QUOTE')
  const taxLabel = safeString(settings?.taxLabel)
  const numberLabel = type === 'INVOICE' ? 'Invoice #' : 'Quote #'
  const number = safeString(share.docNumber)

  const rawStatus = safeString(doc?.status).toUpperCase()
  const status = (type === 'QUOTE'
    ? (['OPEN', 'SENT', 'CLOSED', 'ACCEPTED'].includes(rawStatus) ? (rawStatus as QuoteStatus) : null)
    : (['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'].includes(rawStatus) ? (rawStatus as InvoiceStatus) : null)
  )

  const paidCentsFromDb = type === 'INVOICE'
    ? await (async () => {
        const invoiceId = String(share.docId || '').trim()
        if (!invoiceId) return 0

        const [localAgg, stripeAgg] = await Promise.all([
          (prisma as any).salesPayment
            .aggregate({
              where: { invoiceId, excludeFromInvoiceBalance: false },
              _sum: { amountCents: true },
            })
            .catch(() => null),
          (prisma as any).salesInvoiceStripePayment
            .aggregate({
              where: { invoiceDocId: invoiceId },
              _sum: { invoiceAmountCents: true },
            })
            .catch(() => null),
        ])

        const local = Number(localAgg?._sum?.amountCents ?? 0)
        const stripe = Number(stripeAgg?._sum?.invoiceAmountCents ?? 0)
        const total = (Number.isFinite(local) ? local : 0) + (Number.isFinite(stripe) ? stripe : 0)
        return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
      })()
    : 0

  const nowMs = Date.now()

  const effectiveStatus = (type === 'QUOTE'
    ? (status
      ? computeQuoteEffectiveStatus(
          {
            status: status as QuoteStatus,
            validUntil: (typeof doc?.validUntil === 'string' ? doc.validUntil : null),
          },
          nowMs
        )
      : null)
    : (status
      ? (() => {
          const invoiceStatus = status as InvoiceStatus
          const totalCentsForStatus = Number.isFinite(totalCents) ? totalCents : 0

          // Use real payment totals when possible, but preserve manual PAID/PARTIALLY_PAID status.
          const paidCentsForStatus = invoiceStatus === 'PAID'
            ? Math.max(totalCentsForStatus, paidCentsFromDb)
            : invoiceStatus === 'PARTIALLY_PAID'
              ? Math.max(1, paidCentsFromDb)
              : paidCentsFromDb

          const baseStatus: InvoiceStatus = invoiceStatus === 'OPEN' || invoiceStatus === 'SENT'
            ? invoiceStatus
            : (typeof doc?.sentAt === 'string' ? 'SENT' : 'OPEN')

          return computeInvoiceEffectiveStatus(
            {
              status: baseStatus,
              sentAt: (typeof doc?.sentAt === 'string' ? doc.sentAt : null),
              dueDate: (typeof doc?.dueDate === 'string' ? doc.dueDate : null),
              totalCents: totalCentsForStatus,
              paidCents: paidCentsForStatus,
            },
            nowMs
          )
        })()
      : null)
  )

  const docClientId = safeString(doc?.clientId).trim()
  const docProjectId = safeString(doc?.projectId).trim()

  const [liveClient, liveProject] = await Promise.all([
    docClientId
      ? prisma.client.findFirst({ where: { id: docClientId, deletedAt: null }, select: { name: true, address: true } }).catch(() => null)
      : Promise.resolve(null),
    docProjectId
      ? prisma.project.findFirst({ where: { id: docProjectId }, select: { title: true } }).catch(() => null)
      : Promise.resolve(null),
  ])

  const liveClientName = typeof liveClient?.name === 'string' ? liveClient.name.trim() : ''
  const liveClientAddress = typeof liveClient?.address === 'string' ? liveClient.address.trim() : ''
  const liveProjectTitle = typeof liveProject?.title === 'string' ? liveProject.title.trim() : ''

  const clientName = liveClientName || share.clientName || 'Client'
  const projectTitle = liveProjectTitle || share.projectTitle

  // Prefer the current client address; fall back to any snapshot value if needed.
  const clientAddress = (liveClientAddress || safeString(doc?.clientAddress)).trim()

  // Allow accepting quotes that are OPEN or SENT (not CLOSED, ACCEPTED, or expired)
  const canAcceptQuote = type === 'QUOTE' && (effectiveStatus === 'OPEN' || effectiveStatus === 'SENT')
  const canPayInvoice = type === 'INVOICE'
    && Boolean(stripeGateway?.enabled)
    && effectiveStatus !== 'PAID'

  const stripeCurrency = firstCurrencyFromCsv(stripeGateway?.currencies, currencyCode)
  const displayCurrency = currencyCode

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
            processingFeeCurrency={stripeCurrency}
            currencyCode={currencyCode}
          />
        </div>
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="bg-foreground text-background px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {showLogo && (
                  <div className="mb-3">
                    {hasDarkLogo ? (
                      <>
                        {/* Light mode → dark header → show dark logo */}
                        <Image
                          src="/api/branding/dark-logo"
                          alt="Company logo"
                          width={264}
                          height={88}
                          className="h-11 w-auto object-contain dark:hidden"
                          priority
                        />
                        {/* Dark mode → light header → show normal logo */}
                        <Image
                          src="/api/branding/logo"
                          alt="Company logo"
                          width={264}
                          height={88}
                          className="h-11 w-auto object-contain hidden dark:block"
                          priority
                        />
                      </>
                    ) : (
                      <Image
                        src="/api/branding/logo"
                        alt="Company logo"
                        width={264}
                        height={88}
                        className="h-11 w-auto object-contain"
                        priority
                      />
                    )}
                  </div>
                )}
                <div className="text-lg font-semibold break-words">{businessName}</div>
                {abn && <div className="text-xs opacity-80 mt-0.5">{businessRegistrationLabel}: {abn}</div>}
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
                            ? quoteStatusBadgeClass((effectiveStatus ?? status) as QuoteStatus)
                            : invoiceStatusBadgeClass((effectiveStatus ?? status) as InvoiceStatus)
                        }`
                      }
                    >
                      {type === 'QUOTE'
                        ? quoteStatusLabel((effectiveStatus ?? status) as QuoteStatus)
                        : invoiceStatusLabel((effectiveStatus ?? status) as InvoiceStatus)}
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
                  <div className="text-sm font-medium mt-3 break-words">Project: {projectTitle}</div>
                )}
              </div>
              <div className="text-sm text-muted-foreground sm:text-right">
                <div className="text-xs">Amounts in {displayCurrency}</div>
              </div>
            </div>

            <div className="rounded-lg border">
              <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-foreground text-background">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold min-w-[280px]">Item</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[72px]">Qty</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[104px]">Rate</th>
                    {taxEnabled && <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[104px]">Tax</th>}
                    <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[116px]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={taxEnabled ? 5 : 4} className="px-3 py-10 text-center text-muted-foreground">
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
                      const lineTotal = lineSubtotal + (taxEnabled ? lineTax : 0)

                      const key = safeString(it?.id) || `${index}-${safeString(it?.description)}`

                      return (
                        <tr key={key} className="border-t">
                          <td className="px-3 py-2 align-top min-w-[280px]">
                            <div className="font-medium whitespace-normal break-words">{safeString(it?.description) || '—'}</div>
                            {safeString(it?.details).trim() && (
                              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-1">
                                {safeString(it?.details)}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums align-top whitespace-nowrap min-w-[72px]">{Number.isFinite(qty) ? qty : 0}</td>
                          <td className="px-3 py-2 text-right tabular-nums align-top whitespace-nowrap min-w-[104px]">{formatMoney(Number.isFinite(unit) ? unit : 0, currencySymbol)}</td>
                          {taxEnabled && (
                            <td className="px-3 py-2 text-right tabular-nums align-top whitespace-nowrap min-w-[104px]">
                              {safeString(it?.taxRateName) ? `${safeString(it?.taxRateName)} ${itemTaxRatePercent}%` : `${itemTaxRatePercent}%`}
                            </td>
                          )}
                          <td className="px-3 py-2 text-right tabular-nums align-top font-medium whitespace-nowrap min-w-[116px]">{formatMoney(lineTotal, currencySymbol)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
              </div>
            </div>

            <div className="flex justify-end">
              <div className="w-full sm:w-[320px] space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">{formatMoney(subtotalCents, currencySymbol)}</span>
                </div>
                {taxEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{taxLabel ? `Tax (${taxLabel})` : 'Tax'}</span>
                  <span className="tabular-nums">{formatMoney(taxCents, currencySymbol)}</span>
                </div>
                )}
                <div className="flex justify-between border-t pt-2">
                  <span className="font-semibold">Total</span>
                  <span className="font-semibold tabular-nums">{formatMoney(totalCents, currencySymbol)}</span>
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
