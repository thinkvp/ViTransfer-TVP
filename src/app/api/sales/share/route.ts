import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

async function resolvePublicOrigin(request: NextRequest): Promise<string> {
  const envOrigin = safeOriginFromUrl(process.env.NEXT_PUBLIC_APP_URL)
  if (envOrigin) return envOrigin

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { appDomain: true },
    })
    const dbOrigin = safeOriginFromUrl(settings?.appDomain)
    if (dbOrigin) return dbOrigin
  } catch {
    // ignore, fall back to request-derived origin
  }

  const xfProto = request.headers.get('x-forwarded-proto')
  const xfHost = request.headers.get('x-forwarded-host')
  const proto = (xfProto?.split(',')[0]?.trim() || new URL(request.url).protocol.replace(':', '') || 'http')
  const host = (xfHost?.split(',')[0]?.trim() || request.headers.get('host') || new URL(request.url).host)
  return `${proto}://${host}`
}

function parseDateOnlyLocal(value: unknown): Date | null {
  if (!value) return null
  const s = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null
  const d = new Date(yyyy, mm - 1, dd)
  return Number.isFinite(d.getTime()) ? d : null
}

function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

function computeExpiresAt(input: {
  type: 'QUOTE' | 'INVOICE'
  doc: any
  invoicePaidAt: string | null
}): Date | null {
  if (input.type === 'QUOTE') {
    const validUntil = parseDateOnlyLocal(input.doc?.validUntil)
    if (!validUntil) return null
    return addDaysLocal(endOfDayLocal(validUntil), 30)
  }

  const paidAt = parseDateOnlyLocal(input.invoicePaidAt)
  if (!paidAt) return null
  return addDaysLocal(endOfDayLocal(paidAt), 30)
}

function randomToken(): string {
  // 32 bytes => 43 char base64url-ish, good for unguessable public URLs
  return crypto.randomBytes(32).toString('base64url')
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.'
    },
    'sales-doc-share',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json().catch(() => null) as any

    const type = body?.type
    if (type !== 'QUOTE' && type !== 'INVOICE') {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }

    const doc = body?.doc
    const settings = body?.settings
    if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string') {
      return NextResponse.json({ error: 'Invalid document payload' }, { status: 400 })
    }

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json({ error: 'Invalid settings payload' }, { status: 400 })
    }

    const docId = String(doc.id)
    const docNumber = type === 'QUOTE'
      ? String(doc.quoteNumber || '')
      : String(doc.invoiceNumber || '')

    if (!docNumber.trim()) {
      return NextResponse.json({ error: 'Missing document number' }, { status: 400 })
    }

    let clientName = typeof body?.clientName === 'string' ? body.clientName : null
    const projectTitle = typeof body?.projectTitle === 'string' ? body.projectTitle : null

    const clientId = typeof doc?.clientId === 'string' ? doc.clientId : null
    let clientAddress: string | null = null
    if (clientId) {
      const client = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null },
        select: { name: true, address: true },
      })
      if (!clientName && client?.name) clientName = client.name
      const addr = typeof client?.address === 'string' ? client.address.trim() : ''
      if (addr) clientAddress = addr
    }

    const docSnapshot = clientAddress
      ? { ...doc, clientAddress }
      : doc

    const invoicePaidAt = typeof body?.invoicePaidAt === 'string' ? body.invoicePaidAt : null
    const expiresAt = computeExpiresAt({ type, doc, invoicePaidAt })

    // Reuse one stable token per (type, docId) to avoid link churn.
    // If revoked, create a fresh one.
    const existing = await prisma.salesDocumentShare.findUnique({
      where: {
        type_docId: {
          type,
          docId,
        },
      },
    })

    let token = existing?.token
    if (!token || existing?.revokedAt) token = randomToken()

    const record = await prisma.salesDocumentShare.upsert({
      where: {
        type_docId: {
          type,
          docId,
        },
      },
      create: {
        token,
        type,
        docId,
        docNumber,
        docJson: docSnapshot,
        settingsJson: settings,
        clientName,
        projectTitle,
        expiresAt,
      },
      update: {
        token,
        docNumber,
        docJson: docSnapshot,
        settingsJson: settings,
        clientName,
        projectTitle,
        expiresAt,
        revokedAt: null,
      },
      select: {
        token: true,
      },
    })

    const origin = await resolvePublicOrigin(request)
    const path = `/sales/view/${encodeURIComponent(record.token)}`

    const res = NextResponse.json({
      token: record.token,
      path,
      url: `${origin}${path}`,
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('Failed to create sales share link:', error)
    return NextResponse.json({ error: 'Unable to create share link' }, { status: 500 })
  }
}
