import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function assertProjectAccessOr404(projectId: string, auth: any) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true },
  })
  if (!project) return null

  if (!isVisibleProjectStatusForUser(auth, project.status)) return null

  if (auth.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId: auth.id,
        },
      },
      select: { projectId: true },
    })
    if (!assignment) return null
  }

  return project
}

const keyDateTypeSchema = z.enum(['PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER'])

const patchBodySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
      .optional(),
    allDay: z.boolean().optional(),
    startTime: z
      .union([
        z
          .string()
          .regex(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' }),
        z.literal(''),
        z.null(),
        z.undefined(),
      ])
      .optional(),
    finishTime: z
      .union([
        z
          .string()
          .regex(/^\d{2}:\d{2}$/, { message: 'finishTime must be HH:MM' }),
        z.literal(''),
        z.null(),
        z.undefined(),
      ])
      .optional(),
    type: keyDateTypeSchema.optional(),
    notes: z.union([z.string().max(500), z.literal(''), z.null(), z.undefined()]).optional(),
    reminderAt: z.union([z.string().datetime(), z.literal(''), z.null(), z.undefined()]).optional(),
    reminderTargets: z
      .object({
        userIds: z.array(z.string()).optional(),
        recipientIds: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' })

// PATCH /api/projects/[id]/key-dates/[keyDateId]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyDateId: string }> }
) {
  const { id: projectId, keyDateId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-key-dates-update'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const existing = await prisma.projectKeyDate.findUnique({ where: { id: keyDateId } })
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: 'Key date not found' }, { status: 404 })
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
        recipientIds: Array.isArray(reminderTargetsInput.recipientIds)
          ? reminderTargetsInput.recipientIds.map(String).filter(Boolean)
          : Array.isArray(reminderTargetsExisting?.recipientIds)
            ? reminderTargetsExisting.recipientIds
            : [],
      }
    : reminderTargetsExisting ?? null

  const reminderChanged = Object.prototype.hasOwnProperty.call(parsed.data, 'reminderAt') ||
    Object.prototype.hasOwnProperty.call(parsed.data as any, 'reminderTargets')

  const reminderTargetsHasAny =
    !!reminderTargets &&
    (Array.isArray(reminderTargets.userIds) ? reminderTargets.userIds.length : 0) +
      (Array.isArray(reminderTargets.recipientIds) ? reminderTargets.recipientIds.length : 0) >
      0

  if (reminderChanged && reminderAt && reminderAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Reminder must be set to a future date and time' }, { status: 400 })
  }

  const updated = await prisma.projectKeyDate.update({
    where: { id: keyDateId },
    data: {
      date: parsed.data.date ?? existing.date,
      allDay: nextAllDay,
      startTime,
      finishTime,
      type: parsed.data.type ?? existing.type,
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

// DELETE /api/projects/[id]/key-dates/[keyDateId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyDateId: string }> }
) {
  const { id: projectId, keyDateId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-key-dates-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const existing = await prisma.projectKeyDate.findUnique({ where: { id: keyDateId } })
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: 'Key date not found' }, { status: 404 })
  }

  await prisma.projectKeyDate.delete({ where: { id: keyDateId } })

  return NextResponse.json({ ok: true })
}
