import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { safeStringSchema, cuidSchema } from '@/lib/validation'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createCustomRecipientSchema = z.object({
  name: safeStringSchema(1, 30),
})

const deleteCustomRecipientSchema = z.object({
  recipientId: cuidSchema,
})

/**
 * POST /api/share/[token]/recipients
 * Creates (or reuses) a name-only ProjectRecipient for this project.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    const rateLimitResult = await rateLimit(
      request,
      {
        windowMs: 60 * 1000,
        maxRequests: 30,
        message: 'Too many requests. Please slow down.',
      },
      `share-recipients:${token}`
    )
    if (rateLimitResult) return rateLimitResult

    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: { id: true, sharePassword: true, authMode: true, guestMode: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode
    )

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isGuest } = accessCheck

    // Guests should not be able to create project recipients.
    if (project.guestMode && isGuest) {
      return NextResponse.json({ error: 'Guests cannot add recipients' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const validated = createCustomRecipientSchema.safeParse(body)
    if (!validated.success) {
      return NextResponse.json(
        { error: validated.error.errors[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }

    const name = validated.data.name.trim()

    // Reject if the same name already exists (case-insensitive)
    const existing = await prisma.projectRecipient.findFirst({
      where: {
        projectId: project.id,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true, name: true, createdAt: true },
    })

    if (existing) {
      return NextResponse.json(
        { error: 'That name is already in the list. Please select it instead.' },
        { status: 409 }
      )
    }

    const created = await prisma.projectRecipient.create({
      data: {
        projectId: project.id,
        name,
        email: null,
        isPrimary: false,
      },
      select: { id: true, name: true, createdAt: true },
    })

    return NextResponse.json({
      recipient: {
        id: created.id,
        name: created.name,
        createdAt: created.createdAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Error creating share recipient:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

/**
 * DELETE /api/share/[token]/recipients
 * Deletes a name-only recipient if it was created very recently (<= 60 seconds).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: { id: true, sharePassword: true, authMode: true, guestMode: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode
    )

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isGuest } = accessCheck

    if (project.guestMode && isGuest) {
      return NextResponse.json({ error: 'Guests cannot delete recipients' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const validated = deleteCustomRecipientSchema.safeParse(body)
    if (!validated.success) {
      return NextResponse.json(
        { error: validated.error.errors[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }

    const recipient = await prisma.projectRecipient.findFirst({
      where: {
        id: validated.data.recipientId,
        projectId: project.id,
      },
      select: { id: true, email: true, isPrimary: true, createdAt: true },
    })

    if (!recipient) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    // Only allow deleting name-only recipients created in the last 60 seconds.
    const now = Date.now()
    const ageMs = now - recipient.createdAt.getTime()
    if (recipient.email || recipient.isPrimary || ageMs > 60 * 1000) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    }

    await prisma.projectRecipient.delete({ where: { id: recipient.id } })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting share recipient:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
