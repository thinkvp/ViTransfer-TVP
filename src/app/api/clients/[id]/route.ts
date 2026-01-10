import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const recipientSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(320).email().nullable().optional(),
  displayColor: z.string().trim().max(7).nullable().optional(),
  isPrimary: z.boolean().optional(),
  receiveNotifications: z.boolean().optional(),
})

const updateClientSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  active: z.boolean().optional(),
  recipients: z.array(recipientSchema).optional(),
})

// GET /api/clients/[id] - get client details
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-client-get'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      active: true,
      address: true,
      phone: true,
      website: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      recipients: {
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
      },
      files: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          fileType: true,
          category: true,
          createdAt: true,
          uploadedByName: true,
        },
      },
    },
  })

  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  }

  // BigInt serialization
  const serialized = {
    ...client,
    files: client.files.map((f) => ({
      ...f,
      fileSize: f.fileSize.toString(),
    })),
  }

  return NextResponse.json({ client: serialized })
}

// PATCH /api/clients/[id] - update client
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-client-update'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const parsed = updateClientSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const existing = await prisma.client.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
    if (!existing) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const { name, address, phone, website, notes } = parsed.data
    const active = parsed.data.active

    const recipientsInput = parsed.data.recipients
      ? parsed.data.recipients.map((r) => ({
          name: r.name ?? null,
          email: r.email ?? null,
          displayColor: r.displayColor ?? null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: r.receiveNotifications !== false,
        }))
      : undefined

    const client = await prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id },
        data: {
          ...(typeof name === 'string' ? { name } : {}),
          ...(address !== undefined ? { address: address ?? null } : {}),
          ...(phone !== undefined ? { phone: phone ?? null } : {}),
          ...(website !== undefined ? { website: website ?? null } : {}),
          ...(notes !== undefined ? { notes: notes ?? null } : {}),
          ...(typeof active === 'boolean' ? { active } : {}),
        },
        select: { id: true, name: true },
      })

      if (recipientsInput) {
        const normalized = recipientsInput.filter((r) => r.email || r.name)

        // Ensure at most one primary; default first
        const primaryCount = normalized.filter((r) => r.isPrimary).length
        if (normalized.length > 0) {
          if (primaryCount === 0) normalized[0].isPrimary = true
          else if (primaryCount > 1) {
            let seen = false
            for (const r of normalized) {
              if (r.isPrimary) {
                if (!seen) seen = true
                else r.isPrimary = false
              }
            }
          }
        }

        await tx.clientRecipient.deleteMany({ where: { clientId: id } })
        if (normalized.length > 0) {
          await tx.clientRecipient.createMany({
            data: normalized.map((r) => ({ ...r, clientId: id })),
          })
        }

        // Keep project recipient colours in sync (best-effort) for this client.
        // Only matches recipients by email.
        const projectIds = await tx.project.findMany({
          where: { clientId: id },
          select: { id: true },
        })
        const projectIdList = projectIds.map((p) => p.id)
        if (projectIdList.length > 0) {
          for (const r of normalized) {
            if (!r.email) continue
            await tx.projectRecipient.updateMany({
              where: {
                projectId: { in: projectIdList },
                email: r.email,
              },
              data: { displayColor: r.displayColor ?? null },
            })
          }
        }
      }

      return updated
    })

    return NextResponse.json({ client })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'Client name already exists' }, { status: 409 })
    }
    console.error('Error updating client:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

// DELETE /api/clients/[id] - soft delete client
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'admin-client-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  await prisma.client.update({ where: { id }, data: { deletedAt: new Date() } })
  return NextResponse.json({ ok: true })
}
