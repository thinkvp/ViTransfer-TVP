import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateRequest, createCommentSchema } from '@/lib/validation'
import { getPrimaryRecipient } from '@/lib/recipients'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getSafeguardLimits } from '@/lib/settings'
import {

  validateCommentPermissions,
  resolveCommentAuthor,
  sanitizeAndValidateContent,
  handleCommentNotifications,
  fetchProjectComments,
  maybeRunLegacyCommentBackfills,
  resolveCommentDisplayColorSnapshot

} from '@/lib/comment-helpers'
export const runtime = 'nodejs'


// Prevent static generation for this route
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * GET /api/comments?projectId=xxx
 * Fetch all comments for a project
 */
export async function GET(request: NextRequest) {
  // Rate limiting: 60 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.'
  }, 'comments-read')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')

    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID is required' },
        { status: 400, headers: noStoreHeaders }
      )
    }

    // Fetch the project to check password protection
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        companyName: true,
        hideFeedback: true,
        status: true,
        guestMode: true,
      }
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403, headers: noStoreHeaders }
      )
    }

    // SECURITY: If feedback is hidden (or Share Only mode), return empty array (don't expose comments)
    if (project.hideFeedback || project.status === 'SHARE_ONLY') {
      return NextResponse.json([], { headers: noStoreHeaders })
    }

    // Verify project access using dual auth pattern
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isAdmin, isAuthenticated, isGuest } = accessCheck

    if (project.guestMode && isGuest) {
      return NextResponse.json([], { headers: noStoreHeaders })
    }

    // Get primary recipient for author name fallback
    const primaryRecipient = await getPrimaryRecipient(projectId)
    // Priority: companyName → primary recipient → 'Client'
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

    // Best-effort legacy backfill: link older client comments to a recipient by authorName.
    await maybeRunLegacyCommentBackfills(projectId)

    // Fetch all comments for the project
    const allComments = await prisma.comment.findMany({
      where: {
        projectId,
        parentId: null, // Only get top-level comments
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            displayColor: true,
          }
        },
        recipient: {
          select: {
            id: true,
            displayColor: true,
          }
        },
        files: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        replies: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                email: true,
                displayColor: true,
              }
            },
            recipient: {
              select: {
                id: true,
                displayColor: true,
              }
            },
            files: {
              select: {
                id: true,
                fileName: true,
                fileSize: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    })

    // Sanitize the response data
    const sanitizedComments = allComments.map((comment: any) =>
      sanitizeComment(
        comment,
        isAdmin,
        isAuthenticated,
        fallbackName,
      )
    )

    return NextResponse.json(sanitizedComments, { headers: noStoreHeaders })
  } catch (error) {
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500, headers: noStoreHeaders }
    )
  }
}

export async function POST(request: NextRequest) {
  // Rate limiting to prevent comment spam
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many comments. Please slow down.'
  }, 'comments-create')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

    // Note: Don't log body - may contain PII (emails)

    // Validate and sanitize input
    const validation = validateRequest(createCommentSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400, headers: noStoreHeaders }
      )
    }

    const {
      projectId,
      videoId,
      videoVersion,
      timecode,
      content,
      authorName,
      authorEmail,
      recipientId,
      parentId,
      isInternal
    } = validation.data

    // Get authentication context (single call for both admin and share token)
    const authContext = await getAuthContext(request)

    // Validate comment permissions
    const permissionCheck = await validateCommentPermissions({
      projectId,
      isInternal: isInternal || false,
      currentUser: authContext.user
    })

    if (!permissionCheck.valid) {
      return NextResponse.json(
        { error: permissionCheck.error },
        { status: permissionCheck.errorStatus || 403, headers: noStoreHeaders }
      )
    }

    // Get project for access verification
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        status: true,
      }
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403, headers: noStoreHeaders }
      )
    }

    // Verify project access using dual auth pattern
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return NextResponse.json(
        { error: 'Unable to process request' },
        { status: 400, headers: noStoreHeaders }
      )
    }

    const { isAdmin, isAuthenticated } = accessCheck

    // Resolve author information
    const { authorEmail: finalAuthorEmail, fallbackName } = await resolveCommentAuthor({
      projectId,
      authorEmail,
      recipientId
    })

    // Sanitize and validate content
    const contentValidation = await sanitizeAndValidateContent({
      content,
      authorName
    })

    if (!contentValidation.valid) {
      return NextResponse.json(
        { error: contentValidation.error },
        { status: contentValidation.errorStatus || 400, headers: noStoreHeaders }
      )
    }

    // Replies should not create their own timeline marker/time.
    // For replies, inherit the parent comment's timecode (and version).
    let finalTimecode = timecode

    let finalVideoVersion = videoVersion
    if (parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: parentId },
        select: {
          id: true,
          projectId: true,
          videoId: true,
          videoVersion: true,
          timecode: true,
        },
      })

      if (!parent) {
        return NextResponse.json(
          { error: 'Invalid parent comment' },
          { status: 400, headers: noStoreHeaders }
        )
      }

      // Prevent cross-project/video reply injection.
      if (parent.projectId !== projectId || parent.videoId !== videoId) {
        return NextResponse.json(
          { error: 'Invalid parent comment' },
          { status: 400, headers: noStoreHeaders }
        )
      }

      finalTimecode = parent.timecode
      finalVideoVersion = parent.videoVersion ?? finalVideoVersion
    } else {
      // Non-reply: infer videoVersion if missing
      if (videoId && !videoVersion) {
        const video = await prisma.video.findUnique({
          where: { id: videoId },
          select: { version: true }
        })
        if (video) {
          finalVideoVersion = video.version
        }
      }
    }

    // Safeguard: cap total comments per video version (internal + client, including replies)
    if (videoId && typeof finalVideoVersion === 'number' && Number.isFinite(finalVideoVersion)) {
      const { maxCommentsPerVideoVersion } = await getSafeguardLimits()
      const existingCount = await prisma.comment.count({
        where: {
          projectId,
          videoId,
          videoVersion: finalVideoVersion,
        },
      })

      if (existingCount >= maxCommentsPerVideoVersion) {
        return NextResponse.json(
          { error: `Maximum comments (${maxCommentsPerVideoVersion}) reached for this video version` },
          { status: 400, headers: noStoreHeaders }
        )
      }
    }

    // Create comment in database
    const displayColorSnapshot = await resolveCommentDisplayColorSnapshot({
      projectId,
      isInternal: isInternal || false,
      userId: authContext.user?.id || null,
      recipientId: recipientId || null,
    })

    const comment = await prisma.comment.create({
      data: {
        projectId,
        videoId,
        videoVersion: finalVideoVersion || null,
        timecode: finalTimecode,
        content: contentValidation.sanitizedContent!,
        authorName: contentValidation.sanitizedAuthorName,
        authorEmail: finalAuthorEmail,
        isInternal: isInternal || false,
        parentId: parentId || null,
        userId: authContext.user?.id || null,
        recipientId: recipientId || null,
        displayColorSnapshot,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            displayColor: true,
          }
        },
        recipient: {
          select: {
            id: true,
            displayColor: true,
          }
        },
        replies: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                email: true,
                displayColor: true,
              }
            }
            ,
            recipient: {
              select: {
                id: true,
                displayColor: true,
              }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    })

    // Client recipient activity should mark the project as Reviewed.
    // Only applies to client recipients (recipientId present) and not internal/admin users.
    if (!isInternal && recipientId && !authContext.user?.id) {
      const currentStatus = String((project as any)?.status || '')
      if (currentStatus !== 'APPROVED' && currentStatus !== 'CLOSED' && currentStatus !== 'REVIEWED') {
        try {
          await prisma.$transaction([
            prisma.project.update({
              where: { id: projectId },
              data: { status: 'REVIEWED' },
            }),
            prisma.projectStatusChange.create({
              data: {
                projectId,
                previousStatus: currentStatus as any,
                currentStatus: 'REVIEWED',
                source: 'CLIENT',
                changedById: null,
              },
            }),
          ])
        } catch (e) {
          // Non-blocking: do not prevent comment creation
          console.error('Failed to update project status to REVIEWED:', e)
        }
      }
    }

    // Handle notifications asynchronously
    await handleCommentNotifications({
      comment,
      projectId,
      videoId,
      parentId
    })

    // Fetch all comments for the project (to keep UI in sync)
    const allComments = await fetchProjectComments(projectId)

    // Sanitize the response data
    const sanitizedComments = allComments.map((comment: any) =>
      sanitizeComment(comment, isAdmin, isAuthenticated, fallbackName)
    )

    return NextResponse.json(sanitizedComments, { headers: noStoreHeaders })
  } catch (error) {
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500, headers: noStoreHeaders }
    )
  }
}
