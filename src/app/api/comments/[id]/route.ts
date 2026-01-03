import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { validateRequest, updateCommentSchema } from '@/lib/validation'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { sanitizeCommentHtml } from '@/lib/security/html-sanitization'
import { cancelCommentNotification } from '@/lib/comment-helpers'
import { readdir, rmdir, unlink } from 'fs/promises'
import { dirname, join } from 'path'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

const STORAGE_ROOT = process.env.STORAGE_ROOT || '/app/uploads'

async function removeDirIfEmpty(dirPath: string) {
  try {
    const entries = await readdir(dirPath)
    if (entries.length === 0) {
      await rmdir(dirPath)
    }
  } catch {
    // Best-effort only
  }
}

// PATCH /api/comments/[id] - Update a comment
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limiting to prevent abuse
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'comments-update')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params
    const body = await request.json()

    // Validate input
    const validation = validateRequest(updateCommentSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }

    const { content } = validation.data

    // Get the comment to find its project
    const existingComment = await prisma.comment.findUnique({
      where: { id },
      select: {
        projectId: true,
        project: {
          select: {
            id: true,
            sharePassword: true,
            authMode: true,
            companyName: true,
            hideFeedback: true,
            guestMode: true,
            recipients: {
              where: { isPrimary: true },
              take: 1,
              select: {
                name: true,
              }
            }
          }
        }
      }
    })

    if (!existingComment) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    // SECURITY: If feedback is hidden, reject comment updates
    if (existingComment.project.hideFeedback) {
      return NextResponse.json(
        { error: 'Comments are disabled for this project' },
        { status: 403 }
      )
    }

    // Verify project access using dual auth pattern
    const accessCheck = await verifyProjectAccess(
      request,
      existingComment.project.id,
      existingComment.project.sharePassword,
      existingComment.project.authMode
    )

    if (accessCheck.isGuest) {
      return NextResponse.json(
        { error: 'Comments are disabled for guest users' },
        { status: 403 }
      )
    }

    if (!accessCheck.authorized) {
      // Don't reveal if comment exists - return generic error
      return NextResponse.json(
        { error: 'Unable to process request' },
        { status: 400 }
      )
    }

    const { isAdmin, isAuthenticated } = accessCheck

    // Prepare update data
    const updateData: any = {
      updatedAt: new Date(),
    }

    // SECURITY: Sanitize comment HTML before updating if content is provided (O-7 fix)
    if (content !== undefined) {
      updateData.content = sanitizeCommentHtml(content)
    }

    // Update the comment
    await prisma.comment.update({
      where: { id },
      data: updateData,
    })

    // Return all comments for the project (to keep UI in sync)
    const allComments = await prisma.comment.findMany({
      where: {
        projectId: existingComment.projectId,
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
      },
      orderBy: { createdAt: 'asc' }
    })

    // Sanitize response - never expose PII
    // Priority: companyName → primary recipient → undefined
    const primaryRecipientName = existingComment.project.companyName || existingComment.project.recipients[0]?.name || undefined
    const sanitizedComments = allComments.map((comment: any) => sanitizeComment(
      comment,
      isAdmin,
      isAuthenticated,
      primaryRecipientName,
    ))

    return NextResponse.json(sanitizedComments)
  } catch (error) {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

// DELETE /api/comments/[id] - Delete a comment (admin only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limiting to prevent abuse
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'comments-delete')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params

    // Get the comment and its project for authorization checks
    const existingComment = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        isInternal: true,
        projectId: true,
        project: {
          select: {
            id: true,
            sharePassword: true,
            authMode: true,
            hideFeedback: true,
            allowClientDeleteComments: true,
          }
        }
      }
    })

    if (!existingComment || !existingComment.project) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    const accessCheck = await verifyProjectAccess(
      request,
      existingComment.project.id,
      existingComment.project.sharePassword,
      existingComment.project.authMode
    )

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json(
        { error: 'Unable to process request' },
        { status: 400 }
      )
    }

    if (accessCheck.isGuest) {
      return NextResponse.json(
        { error: 'Comments are disabled for guest users' },
        { status: 403 }
      )
    }

    // SECURITY: If feedback is hidden, block client deletion attempts
    if (existingComment.project.hideFeedback && !accessCheck.isAdmin) {
      return NextResponse.json(
        { error: 'Comments are disabled for this project' },
        { status: 403 }
      )
    }

    // Clients can delete only client comments when allowed by project settings
    if (!accessCheck.isAdmin) {
      if (!existingComment.project.allowClientDeleteComments) {
        return NextResponse.json(
          { error: 'Client comment deletion is disabled for this project' },
          { status: 403 }
        )
      }

      if (existingComment.isInternal) {
        return NextResponse.json(
          { error: 'Only client comments can be deleted by clients' },
          { status: 403 }
        )
      }
    }

    // Cancel any pending notifications for this comment
    await cancelCommentNotification(id)

    // Collect comment ids (parent + replies) before deletion
    const replyIds = await prisma.comment.findMany({
      where: { parentId: id },
      select: { id: true },
    })
    const commentIds = [id, ...replyIds.map(r => r.id)]

    // Collect file paths for cleanup
    const commentFiles = await prisma.commentFile.findMany({
      where: { commentId: { in: commentIds } },
      select: { storagePath: true },
    })

    // Delete the comment and its replies (cascade)
    await prisma.comment.delete({
      where: { id },
    })

    // Best-effort: delete any comment file records (in case cascade isn't configured)
    await prisma.commentFile.deleteMany({
      where: { commentId: { in: commentIds } },
    })

    // Best-effort: remove files from disk
    const directoriesToCheck = new Set<string>()
    for (const file of commentFiles) {
      try {
        const fullPath = join(STORAGE_ROOT, file.storagePath)
        await unlink(fullPath)
        directoriesToCheck.add(dirname(fullPath))
      } catch {
        // Ignore missing/unremovable files to avoid blocking comment deletion
      }
    }

    // Best-effort: remove empty directories (commentId folder, then its parent)
    for (const dirPath of directoriesToCheck) {
      await removeDirIfEmpty(dirPath)
      await removeDirIfEmpty(dirname(dirPath))
    }

    // Return success - client will refresh to get updated comments
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 })
  }
}
