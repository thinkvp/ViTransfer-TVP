import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchBodySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Invalid date value. Please use the date picker.' })
      .optional(),
    allDay: z.boolean().optional(),
    startTime: z
      .union([
        z.string().regex(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' }),
        z.literal(''),
        z.null(),
        z.undefined(),
      ])
      .optional(),
    finishTime: z
      .union([
        z.string().regex(/^\d{2}:\d{2}$/, { message: 'finishTime must be HH:MM' }),
        z.literal(''),
        z.null(),
        z.undefined(),
      ])
      .optional(),
    title: z.string().trim().min(1, { message: 'title is required' }).max(120).optional(),
    notes: z.union([z.string().max(500), z.literal(''), z.null(), z.undefined()]).optional(),
    reminderAt: z.union([z.string().datetime(), z.literal(''), z.null(), z.undefined()]).optional(),
    reminderTargets: z
      .object({
        userIds: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' })

// PATCH /api/users/me/key-dates/[keyDateId]
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ keyDateId: string }> }) {
  const { keyDateId } = await params

  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'user-key-dates-update'
  )
  if (rateLimitResult) return rateLimitResult

  const existing = await prisma.userKeyDate.findUnique({ where: { id: keyDateId } })
  if (!existing || existing.userId !== authResult.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = patchBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const nextAllDay = parsed.data.allDay ?? existing.allDay

  const startTime = nextAllDay ? null : (parsed.data.startTime ?? existing.startTime ?? null) || null
  const finishTime = nextAllDay ? null : (parsed.data.finishTime ?? existing.finishTime ?? null) || null
  const notes = (parsed.data.notes ?? existing.notes ?? null) || null

  const reminderAtRaw = parsed.data.reminderAt
  const reminderAtParsed = reminderAtRaw ? new Date(reminderAtRaw as any) : null
  const reminderAt =
    reminderAtRaw === '' || reminderAtRaw == null
      ? null
      : reminderAtParsed && !isNaN(reminderAtParsed.getTime())
        ? reminderAtParsed
        : existing.reminderAt

  const reminderTargetsInput = (parsed.data as any).reminderTargets
  const reminderTargetsExisting = (existing as any).reminderTargets
  const reminderTargets = reminderTargetsInput
    ? {
        userIds: Array.isArray(reminderTargetsInput.userIds)
          ? reminderTargetsInput.userIds.map(String).filter(Boolean)
          : Array.isArray(reminderTargetsExisting?.userIds)
            ? reminderTargetsExisting.userIds
            : [],
      }
    : reminderTargetsExisting ?? null

  const reminderChanged =
    Object.prototype.hasOwnProperty.call(parsed.data, 'reminderAt') ||
    Object.prototype.hasOwnProperty.call(parsed.data as any, 'reminderTargets')

  const reminderTargetsHasAny =
    !!reminderTargets && (Array.isArray(reminderTargets.userIds) ? reminderTargets.userIds.length : 0) > 0

  if (reminderChanged && reminderAt && reminderAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Reminder must be set to a future date and time' }, { status: 400 })
  }

  const updated = await prisma.userKeyDate.update({
    where: { id: keyDateId },
    data: {
      date: parsed.data.date ?? existing.date,
      allDay: nextAllDay,
      startTime,
      finishTime,
      title: parsed.data.title ?? existing.title,
      notes,
      ...(reminderChanged
        ? {
            reminderAt,
            reminderTargets: reminderTargetsHasAny ? (reminderTargets as Prisma.InputJsonValue) : Prisma.DbNull,
            reminderSentAt: null,
            reminderLastAttemptAt: null,
            reminderAttemptCount: 0,
            reminderLastError: null,
          }
        : {}),
    },
  })

  return NextResponse.json({ keyDate: updated })
}

// DELETE /api/users/me/key-dates/[keyDateId]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ keyDateId: string }> }) {
  const { keyDateId } = await params

  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'user-key-dates-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const existing = await prisma.userKeyDate.findUnique({ where: { id: keyDateId } })
  if (!existing || existing.userId !== authResult.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await prisma.userKeyDate.delete({ where: { id: keyDateId } })
  return NextResponse.json({ ok: true })
}
