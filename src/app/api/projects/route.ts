import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateUniqueSlug } from '@/lib/utils'
import { requireApiAuth } from '@/lib/auth'
import { encrypt } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { createProjectSchema, validateRequest } from '@/lib/validation'
import { getUserPermissions, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getSafeguardLimits } from '@/lib/settings'
export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

function asNumberBigInt(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

// GET /api/projects - List all projects
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  // Rate limiting: 100 requests per minute for listing projects
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests. Please slow down.'
  }, 'admin-projects-list')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const permissions = getUserPermissions(authResult)
    const allowedStatuses = permissions.projectVisibility.statuses
    const isSystemAdmin = authResult.appRoleIsSystemAdmin === true

    if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0) {
      const response = NextResponse.json({ projects: [] })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    }

    // Optimized query: only fetch essential fields + minimal video data for list view
    const projects = await prisma.project.findMany({
      where: {
        status: { in: allowedStatuses as any },
        ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        totalBytes: true,
        watermarkEnabled: true,
        sharePassword: true,
        authMode: true,
        hideFeedback: true,
        guestMode: true,
        previewResolution: true,
        companyName: true,
        clientId: true,
        maxRevisions: true,
        enableRevisions: true,
        assignedUsers: {
          orderBy: { createdAt: 'asc' },
          select: {
            receiveNotifications: true,
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                displayColor: true,
              },
            },
          },
        },
        videos: {
          select: {
            id: true,
            status: true,
            name: true,
            approved: true,
          },
        },
        recipients: {
          select: {
            id: true,
            name: true,
            email: true,
            isPrimary: true,
          },
        },
        _count: {
          select: {
            videos: true,
            comments: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    const projectIds = projects.map((p) => p.id)
    const photoCountByProjectId = new Map<string, number>()

    if (projectIds.length > 0) {
      const albumRows = await prisma.album.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          projectId: true,
          _count: { select: { photos: true } },
        },
      })

      for (const row of albumRows) {
        const prev = photoCountByProjectId.get(row.projectId) ?? 0
        photoCountByProjectId.set(row.projectId, prev + (row._count?.photos ?? 0))
      }
    }

    const projectsWithPhotoCounts = projects.map((p) => ({
      ...p,
      photoCount: photoCountByProjectId.get(p.id) ?? 0,
      totalBytes: asNumberBigInt((p as any).totalBytes),
      assignedUsers:
        (p as any).assignedUsers
          ?.map((pu: any) => ({
            ...(pu.user || {}),
            receiveNotifications: pu.receiveNotifications !== false,
          }))
          .filter((u: any) => u?.id) || [],
    }))

    const response = NextResponse.json({ projects: projectsWithPhotoCounts })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  // Check authentication
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const admin = authResult

  // Rate limiting: Max 20 projects per hour
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,
    message: 'Too many projects created. Please try again later.'
  }, 'create-project')
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()

    // Validate request body
    const validation = validateRequest(createProjectSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }

    const {
      title,
      description,
      clientId,
      assignedUserIds,
      recipients,
      recipientEmail,
      recipientName,
      sharePassword,
      authMode,
      enableVideos,
      enablePhotos,
      enableRevisions,
      maxRevisions,
      restrictCommentsToLatestVersion,
      allowClientDeleteComments,
      isShareOnly
    } = validation.data

    const finalEnableVideos = enableVideos !== undefined ? Boolean(enableVideos) : true
    const finalEnablePhotos = enablePhotos !== undefined ? Boolean(enablePhotos) : false
    if (!finalEnableVideos && !finalEnablePhotos) {
      return NextResponse.json(
        { error: 'Project must have at least one type enabled (Video and/or Photo)' },
        { status: 400 }
      )
    }

    const requestedAssignmentsRaw: Array<{ userId: string; receiveNotifications: boolean }> =
      Array.isArray((validation.data as any).assignedUsers)
        ? ((validation.data as any).assignedUsers as any[])
            .map((u) => ({
              userId: String(u?.userId || ''),
              receiveNotifications: u?.receiveNotifications !== false,
            }))
            .filter((u) => u.userId)
        : Array.isArray(assignedUserIds)
          ? (assignedUserIds as any[]).map((id) => ({ userId: String(id || ''), receiveNotifications: true })).filter((u) => u.userId)
          : []

    const requestedAssignments = Array.from(
      new Map(requestedAssignmentsRaw.map((u) => [u.userId, u])).values()
    )

    // Only system admins have access to all projects; non-system-admins must be explicitly assigned.
    // To prevent accidentally locking a non-system-admin creator out of their own project,
    // ensure the creator is always assigned when they're not a system admin.
    const creatorId = admin.id
    const creatorMustBeAssigned = admin.appRoleIsSystemAdmin !== true
    const effectiveAssigned = creatorMustBeAssigned
      ? Array.from(
          new Map(
            [...requestedAssignments, { userId: creatorId, receiveNotifications: true }].map((u) => [u.userId, u])
          ).values()
        )
      : requestedAssignments

    // Ensure at least one system admin is associated with every project.
    // Default behavior: include all system admins unless explicitly present.
    const systemAdmins = await prisma.user.findMany({
      where: { appRole: { isSystemAdmin: true } },
      select: { id: true },
    })
    if (systemAdmins.length === 0) {
      return NextResponse.json(
        { error: 'No system admin users exist. Create an admin before creating projects.' },
        { status: 400 }
      )
    }

    const hasAdminAlready = effectiveAssigned.some((u) => systemAdmins.some((a) => a.id === u.userId))
    const effectiveWithAdmins = hasAdminAlready
      ? effectiveAssigned
      : Array.from(
          new Map(
            [...effectiveAssigned, ...systemAdmins.map((a) => ({ userId: a.id, receiveNotifications: true }))]
              .map((u) => [u.userId, u])
          ).values()
        )

    // Validate that all assigned users exist
    let validatedAssignments: Array<{ userId: string; receiveNotifications: boolean }> = []
    if (effectiveWithAdmins.length > 0) {
      const effectiveIds = effectiveWithAdmins.map((u) => u.userId)
      const rows = await prisma.user.findMany({
        where: { id: { in: effectiveIds } },
        select: { id: true },
      })

      const foundById = new Set(rows.map((r) => r.id))
      const missing = effectiveIds.filter((id) => !foundById.has(id))
      if (missing.length > 0) {
        return NextResponse.json(
          { error: 'One or more assigned users were not found' },
          { status: 400 }
        )
      }

      validatedAssignments = effectiveWithAdmins
    }

    // Enforce that projects must be linked to an existing client.
    if (!clientId) {
      return NextResponse.json(
        { error: 'Client is required' },
        { status: 400 }
      )
    }

    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true, name: true },
    })

    if (!client) {
      return NextResponse.json(
        { error: 'Client not found' },
        { status: 400 }
      )
    }

    const normalizeEmail = (email: any): string | null => {
      const v = typeof email === 'string' ? email.trim().toLowerCase() : ''
      return v && v.includes('@') ? v : null
    }

    const normalizeName = (name: any): string | null => {
      const v = typeof name === 'string' ? name.trim() : ''
      return v ? v : null
    }

    const normalizeDisplayColor = (color: any): string | null => {
      const v = typeof color === 'string' ? color.trim() : ''
      if (!v) return null
      return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null
    }

    const normalizeRecipients = (input: any[] | undefined) => {
      const list = Array.isArray(input) ? input : []
      const mapped = list
        .map((r: any) => ({
          email: normalizeEmail(r?.email),
          name: normalizeName(r?.name),
          displayColor: normalizeDisplayColor(r?.displayColor),
          alsoAddToClient: Boolean(r?.alsoAddToClient),
          isPrimary: Boolean(r?.isPrimary),
          receiveNotifications: r?.receiveNotifications !== false,
        }))
        .filter((r) => r.email || r.name)

      if (mapped.length === 0) return mapped

      const primaryCount = mapped.filter((r) => r.isPrimary).length
      if (primaryCount === 0) mapped[0].isPrimary = true
      else if (primaryCount > 1) {
        let seen = false
        for (const r of mapped) {
          if (r.isPrimary) {
            if (!seen) seen = true
            else r.isPrimary = false
          }
        }
      }

      return mapped
    }

    const recipientsFromArray = normalizeRecipients(recipients as any)
    const legacyEmail = normalizeEmail(recipientEmail)
    const legacyName = normalizeName(recipientName)
    const effectiveRecipients = recipientsFromArray.length
      ? recipientsFromArray
      : legacyEmail
        ? [{ email: legacyEmail, name: legacyName, displayColor: null, alsoAddToClient: false, isPrimary: true, receiveNotifications: true }]
        : []

    const { maxProjectRecipients } = await getSafeguardLimits()
    if (effectiveRecipients.length > maxProjectRecipients) {
      return NextResponse.json(
        { error: `Maximum recipients (${maxProjectRecipients}) exceeded for this project` },
        { status: 400 }
      )
    }

    // Normalize auth/password inputs
    const trimmedPassword = sharePassword?.trim()
    const resolvedAuthMode = authMode || 'PASSWORD'

    // Enforce password presence for password-based modes
    if (resolvedAuthMode === 'PASSWORD' || resolvedAuthMode === 'BOTH') {
      if (!trimmedPassword) {
        return NextResponse.json(
          { error: 'Password authentication mode requires a share password.' },
          { status: 400 }
        )
      }
      // Password strength validation (8+ chars, letter, number) is handled by Zod schema
    }

    // Clear password for modes that don't use it
    const passwordForStorage = (resolvedAuthMode === 'OTP' || resolvedAuthMode === 'NONE')
      ? null
      : (trimmedPassword || null)

    // Fetch default settings for watermark and preview resolution
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        defaultPreviewResolution: true,
        defaultWatermarkEnabled: true,
        defaultWatermarkText: true,
        defaultTimelinePreviewsEnabled: true,
        defaultAllowClientDeleteComments: true,
        defaultAllowClientUploadFiles: true,
        defaultMaxClientUploadAllocationMB: true,
      },
    })

    // Generate unique slug from title
    const slug = await generateUniqueSlug(title, prisma)

    // Encrypt share password if provided (so we can decrypt it later for email notifications)
    const encryptedSharePassword = passwordForStorage ? encrypt(passwordForStorage) : null

    // Use transaction to ensure atomicity: if recipient creation fails, project creation is rolled back
    const project = await prisma.$transaction(async (tx) => {
      const newProject = await tx.project.create({
        data: {
          title,
          slug,
          description,
          companyName: client.name,
          clientId: client.id,
          enableVideos: finalEnableVideos,
          enablePhotos: finalEnablePhotos,
          sharePassword: encryptedSharePassword,
          authMode: resolvedAuthMode,
          enableRevisions: isShareOnly ? false : (enableRevisions || false),
          maxRevisions: isShareOnly ? 0 : (enableRevisions ? (maxRevisions || 3) : 0),
          restrictCommentsToLatestVersion: isShareOnly ? false : (restrictCommentsToLatestVersion || false),
          allowClientDeleteComments: isShareOnly ? false : (allowClientDeleteComments ?? settings?.defaultAllowClientDeleteComments ?? false),
          allowClientUploadFiles: isShareOnly ? false : (settings?.defaultAllowClientUploadFiles ?? false),
          maxClientUploadAllocationMB: settings?.defaultMaxClientUploadAllocationMB ?? 1000,
          status: isShareOnly ? 'SHARE_ONLY' : 'NOT_STARTED',
          hideFeedback: isShareOnly ? true : false,
          approvedAt: isShareOnly ? new Date() : null,
          previewResolution: settings?.defaultPreviewResolution || '720p',
          watermarkEnabled: settings?.defaultWatermarkEnabled ?? true,
          watermarkText: settings?.defaultWatermarkText || null,
          timelinePreviewsEnabled: settings?.defaultTimelinePreviewsEnabled ?? false,
          createdById: admin.id,
        },
      })

      if (validatedAssignments.length > 0) {
        await tx.projectUser.createMany({
          data: validatedAssignments.map((a) => ({
            projectId: newProject.id,
            userId: a.userId,
            receiveNotifications: a.receiveNotifications !== false,
          })),
          skipDuplicates: true,
        })
      }

      if (effectiveRecipients.length > 0) {
        await tx.projectRecipient.createMany({
          data: effectiveRecipients.map((r) => ({
            projectId: newProject.id,
            email: r.email,
            name: r.name,
            displayColor: r.displayColor ?? null,
            isPrimary: r.isPrimary,
            receiveNotifications: r.receiveNotifications,
          })),
        })
      }

      // Optionally add recipients to the Client profile (matched by email)
      if (newProject.clientId) {
        const toAdd = effectiveRecipients.filter((r) => r.alsoAddToClient && r.email)
        if (toAdd.length > 0) {
          const emails = Array.from(new Set(toAdd.map((r) => String(r.email || '').trim()).filter(Boolean)))
          const existing = await tx.clientRecipient.findMany({
            where: { clientId: newProject.clientId, email: { in: emails } },
            select: { email: true },
          })
          const existingSet = new Set(existing.map((r) => String(r.email || '').trim()))

          const missing = toAdd.filter((r) => r.email && !existingSet.has(String(r.email).trim()))
          if (missing.length > 0) {
            await tx.clientRecipient.createMany({
              data: missing.map((r) => ({
                clientId: newProject.clientId as string,
                email: r.email,
                name: r.name,
                displayColor: r.displayColor ?? null,
                isPrimary: false,
                receiveNotifications: true,
              })),
            })
          }

          // If already present, sync displayColor/name best-effort
          for (const r of toAdd) {
            if (!r.email) continue
            await tx.clientRecipient.updateMany({
              where: { clientId: newProject.clientId, email: r.email },
              data: {
                displayColor: r.displayColor ?? null,
                ...(r.name ? { name: r.name } : {}),
              },
            })
          }
        }
      }

      return newProject
    })

    const response = NextResponse.json({
      ...project,
      totalBytes: asNumberBigInt((project as any).totalBytes),
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[API] Project creation error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create project' },
      { status: 500 }
    )
  }
}
