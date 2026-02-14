import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { sendPushNotification } from '@/lib/push-notifications'
import { sendAdminInvoicePaidEmail } from '@/lib/email'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

function parseIntSafe(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

function formatMoneyWithCurrency(cents: number, currency: string): string {
  const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  const amount = (cents / 100).toFixed(2)
  return cur ? `${cur} ${amount}` : amount
}

export async function POST(request: NextRequest) {
  const webhookSecret = typeof process.env.STRIPE_WEBHOOK_SECRET === 'string' ? process.env.STRIPE_WEBHOOK_SECRET.trim() : ''
  if (!webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, { status: 500 })
  }

  const sig = request.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })

  const rawBody = await request.text()

  // API key is not used for signature verification, but Stripe SDK requires a non-empty string.
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim() || 'sk_test_dummy', {
    apiVersion: '2023-10-16',
    typescript: true,
  })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session

    const paymentStatus = typeof session.payment_status === 'string'
      ? session.payment_status.toLowerCase()
      : ''

    // Only treat checkout sessions as paid once Stripe confirms funds captured.
    // This prevents prematurely marking invoices as PAID for delayed payment methods.
    if (paymentStatus !== 'paid') {
      return NextResponse.json({ received: true })
    }

    const metadata = (session.metadata ?? {}) as Record<string, string>
    const shareToken = metadata.shareToken
    const docId = metadata.docId
    const invoiceNumber = metadata.invoiceNumber

    if (!shareToken || !docId || !invoiceNumber) {
      return NextResponse.json({ error: 'Missing required metadata' }, { status: 400 })
    }

    const currency = (metadata.currency || session.currency || 'aud').toString().toUpperCase()

    const invoiceAmountCents = parseIntSafe(metadata.invoiceAmountCents)
    const feeAmountCents = parseIntSafe(metadata.feeAmountCents) ?? 0
    const totalAmountCents = parseIntSafe(metadata.totalAmountCents) ?? parseIntSafe(session.amount_total) ?? null

    if (invoiceAmountCents == null || totalAmountCents == null) {
      return NextResponse.json({ error: 'Missing amount metadata' }, { status: 400 })
    }

    // Idempotency via unique session id.
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (!sessionId) return NextResponse.json({ error: 'Missing session id' }, { status: 400 })

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null

    const recordId = crypto.randomUUID()

    const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "SalesInvoiceStripePayment" (
        "id",
        "shareToken",
        "invoiceDocId",
        "invoiceNumber",
        "currency",
        "invoiceAmountCents",
        "feeAmountCents",
        "totalAmountCents",
        "stripeCheckoutSessionId",
        "stripePaymentIntentId",
        "createdAt"
      )
      VALUES (
        ${recordId},
        ${shareToken},
        ${docId},
        ${invoiceNumber},
        ${currency},
        ${invoiceAmountCents},
        ${feeAmountCents},
        ${totalAmountCents},
        ${sessionId},
        ${paymentIntentId},
        NOW()
      )
      ON CONFLICT ("stripeCheckoutSessionId") DO NOTHING
      RETURNING "id"
    `

    const didInsert = Array.isArray(inserted) && inserted.length > 0

    const nowMs = Date.now()

    if (didInsert) {
      // Keep stored invoice status and any active public share snapshot in sync.
      await recomputeInvoiceStoredStatus(prisma as any, String(docId), { createdByUserId: null, nowMs }).catch(() => null)
    }

    // Best-effort: mark the public invoice snapshot as paid.
    const paidAtIso = new Date(nowMs).toISOString()
    const paidAtYmd = paidAtIso.slice(0, 10)

    const expiresAt = addDaysLocal(endOfDayLocal(new Date()), 30)

    const existingShare = await prisma.salesDocumentShare.findUnique({
      where: { token: shareToken },
      select: { docId: true, docJson: true, clientName: true, projectTitle: true, docNumber: true },
    }).catch(() => null)

    const currentDoc = (existingShare?.docJson ?? {}) as any
    const nextDoc = {
      ...currentDoc,
      status: 'PAID',
      invoicePaidAt: paidAtYmd,
      paidAt: paidAtIso,
      stripePaymentIntentId: paymentIntentId,
    }

    await prisma.salesDocumentShare
      .update({
        where: { token: shareToken },
        data: {
          docJson: nextDoc,
          expiresAt,
        },
      })
      .catch(() => {})

    // Notifications: only on first insert for this Checkout Session.
    if (didInsert) {
      const projectId = typeof currentDoc?.projectId === 'string' ? currentDoc.projectId : null
      const clientName = typeof existingShare?.clientName === 'string' ? existingShare.clientName : null
      const projectTitle = typeof existingShare?.projectTitle === 'string' ? existingShare.projectTitle : null
      const docNumberSafe = typeof existingShare?.docNumber === 'string' ? existingShare.docNumber : invoiceNumber
      const invoiceId = typeof (existingShare as any)?.docId === 'string' ? String((existingShare as any).docId) : null

      await sendPushNotification({
        type: 'SALES_INVOICE_PAID',
        projectId: projectId || undefined,
        projectName: projectTitle || undefined,
        title: 'Invoice Paid',
        message: `${docNumberSafe} was paid via Stripe`,
        details: {
          ...(invoiceId
            ? {
                salesInvoiceId: invoiceId,
                __link: { href: `/admin/sales/invoices/${encodeURIComponent(invoiceId)}` },
              }
            : {}),
          'Invoice': docNumberSafe,
          'Client': clientName || undefined,
          'Project': projectTitle || undefined,
          'Currency': currency,
          'Amount (invoice)': formatMoneyWithCurrency(invoiceAmountCents, currency),
          'Amount (total)': formatMoneyWithCurrency(totalAmountCents, currency),
          'Payment Intent': paymentIntentId || undefined,
        },
      }).catch(() => {})

      // Email: send to all admins who can access the Sales menu.
      // (Project assignment is not required; otherwise admins may miss invoice paid events.)
      try {
        const appDomain = (process.env.APP_DOMAIN || '').trim()
        const publicInvoiceUrl = appDomain ? `${appDomain.replace(/\/$/, '')}/sales/view/${encodeURIComponent(shareToken)}` : null
        const projectAdminUrl = (appDomain && projectId)
          ? `${appDomain.replace(/\/$/, '')}/admin/projects/${encodeURIComponent(projectId)}`
          : null

        // If the invoice belongs to a project, include project-assigned admins who opted into notifications.
        const assigned = projectId
          ? await prisma.projectUser.findMany({
              where: {
                projectId,
                receiveNotifications: true,
              },
              select: {
                user: {
                  select: {
                    email: true,
                    role: true,
                    appRole: { select: { isSystemAdmin: true, permissions: true } },
                  },
                },
              },
            }).catch(() => [])
          : []

        const globalAdmins = await prisma.user.findMany({
          select: {
            email: true,
            role: true,
            appRole: { select: { isSystemAdmin: true, permissions: true } },
          },
        }).catch(() => [])

        const candidates = [
          ...(assigned || []).map((a: any) => a?.user).filter(Boolean),
          ...(globalAdmins || []),
        ]

        const adminEmails = Array.from(new Set(
          candidates
            .filter((u: any) => u && typeof u.email === 'string' && u.email.trim())
            .filter((u: any) => {
              const isSystemAdmin = u?.appRole?.isSystemAdmin === true
              const perms = isSystemAdmin ? adminAllPermissions() : normalizeRolePermissions(u?.appRole?.permissions)
              return canSeeMenu(perms, 'sales')
            })
            .map((u: any) => u.email.trim())
            .filter(Boolean)
        ))

        if (adminEmails.length === 0) {
          console.warn('[STRIPE_WEBHOOK] No admin recipients for invoice paid email', { projectId, shareToken })
        } else {
          const result = await sendAdminInvoicePaidEmail({
            adminEmails,
            projectTitle,
            invoiceNumber: docNumberSafe,
            clientName,
            currency,
            invoiceAmountCents,
            feeAmountCents,
            totalAmountCents,
            paidAtYmd,
            publicInvoiceUrl,
            projectAdminUrl,
          })

          if (!result?.success) {
            console.error('[STRIPE_WEBHOOK] Invoice paid email send failed', { message: result?.message })
          }
        }
      } catch (e) {
        console.error('[STRIPE_WEBHOOK] Unexpected error sending invoice paid email', e)
      }
    }
  }

  return NextResponse.json({ received: true })
}
