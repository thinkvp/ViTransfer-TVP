import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { qboQuery, refreshQuickBooksAccessToken, getQuickBooksConfig, toQboDateTime } from '@/lib/quickbooks/qbo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getLookbackDays(request: NextRequest): Promise<number> {
  const body = await request.json().catch(() => null)
  const daysRaw = typeof body?.days === 'number' ? body.days : Number(body?.days)
  const days = Number.isFinite(daysRaw) ? Math.floor(daysRaw) : 7
  return Math.min(Math.max(days, 0), 3650)
}

type QboCustomer = {
  Id?: string
  DisplayName?: string
  GivenName?: string
  FamilyName?: string
  CompanyName?: string
  Active?: boolean
  PrimaryPhone?: { FreeFormNumber?: string }
  PrimaryEmailAddr?: { Address?: string }
  WebAddr?: { URI?: string }
  MetaData?: { LastUpdatedTime?: string }
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

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 5,
      message: 'Too many pulls. Please wait a moment.'
    },
    'sales-qbo-pull-customers',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const cfg = await getQuickBooksConfig()
  if (!cfg.configured) {
    return NextResponse.json({ configured: false, missing: cfg.missing }, { status: 400 })
  }

  try {
    const lookbackDays = await getLookbackDays(request)
    const auth = await refreshQuickBooksAccessToken()

    const since = new Date()
    since.setDate(since.getDate() - lookbackDays)
    const sinceQbo = toQboDateTime(since)

    const pageSize = 1000
    let startPosition = 1

    const customers: QboCustomer[] = []
    while (true) {
      const whereClause = lookbackDays > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
      // NOTE: QBO query language does not allow selecting complex fields (e.g., BillAddr) explicitly.
      // Use SELECT * so address and other complex objects are included.
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
        select: { id: true, name: true, address: true, phone: true, website: true, notes: true, active: true, quickbooksCustomerId: true },
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

    const res = NextResponse.json({
      configured: true,
      rotatedRefreshToken: auth.rotatedRefreshToken,
      refreshTokenSource: auth.refreshTokenSource,
      refreshTokenPersisted: auth.refreshTokenPersisted,
      lookbackDays,
      fetched: customers.length,
      created,
      updated,
      linkedByName,
      recipientsCreatedOrLinked,
      skipped,
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('QuickBooks pull customers failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'QuickBooks pull failed' },
      { status: 500 }
    )
  }
}
