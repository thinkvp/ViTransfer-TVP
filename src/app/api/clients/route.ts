import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const recipientSchema = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(320).email().nullable().optional(),
  displayColor: z.string().trim().max(7).nullable().optional(),
  isPrimary: z.boolean().optional(),
  receiveNotifications: z.boolean().optional(),
})

const createClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  recipients: z.array(recipientSchema).optional(),
})

type ClientListItem = {
  id: string
  name: string
  contacts: number
  primaryContact: string | null
  primaryEmail: string | null
  createdAt: Date
  updatedAt: Date
}

function pickPrimaryRecipient(recipients: Array<{ name: string | null; email: string | null; isPrimary: boolean }>) {
  if (!Array.isArray(recipients) || recipients.length === 0) return null
  const primary = recipients.find((r) => r.isPrimary) ?? recipients[0]
  return primary
}

// GET /api/clients - list/search clients
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-clients-list'
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const query = url.searchParams.get('query')?.trim() || ''
  const includeRecipients = url.searchParams.get('includeRecipients') === '1'

  try {
    const clients = await prisma.client.findMany({
      where: {
        deletedAt: null,
        ...(query
          ? {
              name: {
                contains: query,
                mode: 'insensitive',
              },
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: query ? 10 : 500,
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            recipients: true,
          },
        },
        recipients: includeRecipients
          ? {
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
              select: {
                id: true,
                name: true,
                email: true,
                displayColor: true,
                isPrimary: true,
                receiveNotifications: true,
                createdAt: true,
              },
            }
          : {
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
              take: 1,
              select: {
                name: true,
                email: true,
                isPrimary: true,
              },
            },
      },
    })

    const list: Array<ClientListItem & { recipients?: any[] }> = clients.map((c: any) => {
      const primary = pickPrimaryRecipient((c.recipients || []) as any)
      const primaryContact = primary?.name || primary?.email || null
      const primaryEmail = primary?.email || null

      return {
        id: c.id,
        name: c.name,
        contacts: Number(c?._count?.recipients ?? 0),
        primaryContact,
        primaryEmail,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        ...(includeRecipients ? { recipients: c.recipients } : {}),
      }
    })

    const response = NextResponse.json({ clients: list })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error listing clients:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

// POST /api/clients - create client
export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'admin-clients-create'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const parsed = createClientSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const { name, address, phone, website, notes } = parsed.data
    const recipients = (parsed.data.recipients || []).map((r) => ({
      name: r.name ?? null,
      email: r.email ?? null,
      displayColor: r.displayColor ?? null,
      isPrimary: Boolean(r.isPrimary),
      receiveNotifications: r.receiveNotifications !== false,
    }))

    const hasAnyRecipient = recipients.some((r) => (r.email && r.email.includes('@')) || (r.name && r.name.trim() !== ''))
    const normalizedRecipients = hasAnyRecipient ? recipients.filter((r) => (r.email || r.name)) : []

    // Ensure at most one primary; default the first recipient to primary
    const primaryCount = normalizedRecipients.filter((r) => r.isPrimary).length
    if (normalizedRecipients.length > 0) {
      if (primaryCount === 0) {
        normalizedRecipients[0].isPrimary = true
      } else if (primaryCount > 1) {
        let seen = false
        for (const r of normalizedRecipients) {
          if (r.isPrimary) {
            if (!seen) seen = true
            else r.isPrimary = false
          }
        }
      }
    }

    const client = await prisma.client.create({
      data: {
        name,
        address: address ?? null,
        phone: phone ?? null,
        website: website ?? null,
        notes: notes ?? null,
        recipients: normalizedRecipients.length
          ? {
              create: normalizedRecipients,
            }
          : undefined,
      },
      select: { id: true, name: true },
    })

    return NextResponse.json({ client }, { status: 201 })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'Client name already exists' }, { status: 409 })
    }
    console.error('Error creating client:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
