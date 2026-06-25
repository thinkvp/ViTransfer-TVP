import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { batchResolveFileSizes, getUserIdsWithAvatar } from '@/lib/stored-file'
import { getRateLimitSettings } from '@/lib/settings'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * GET /api/share/[token]/comments
 *
 * Load comments for a share page (token-based access)
 * Replaces direct project ID access for better security
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const { ipRateLimit } = await getRateLimitSettings()

    // Rate limiting to prevent scraping
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: ipRateLimit ? Math.max(1, Math.min(ipRateLimit, 1000)) : 30,
      message: 'Too many requests. Please slow down.'
    }, `share-comments:${token}`)

    if (rateLimitResult) return rateLimitResult

    // Fetch project by token (not by ID - more secure)
    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        companyName: true,
        hideFeedback: true,
        status: true,
      }
    })

    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403, headers: noStoreHeaders })
    }

    // SECURITY: If feedback is hidden (or Share Only mode), return empty array (don't expose comments)
    if (project.hideFeedback || project.status === 'SHARE_ONLY') {
      return NextResponse.json([], { headers: noStoreHeaders })
    }

    // Get primary recipient for author name
    const primaryRecipient = await getPrimaryRecipient(project.id)
    // Priority: companyName → primary recipient → 'Client'
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

    // Verify project access using bearer admin/share tokens
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isAdmin, isAuthenticated } = accessCheck

    // Fetch comments with nested replies
    const comments = await prisma.comment.findMany({
      where: {
        projectId: project.id,
        parentId: null, // Only top-level comments
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
              }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    })

    // Resolve comment file sizes from StoredFile (CommentFile model has no fileSize column)
    const allFileIds: string[] = []
    for (const comment of comments as any[]) {
      for (const f of (comment.files || [])) allFileIds.push(f.id)
      for (const reply of (comment.replies || [])) {
        for (const f of (reply.files || [])) allFileIds.push(f.id)
      }
    }
    const commentFileSizeMap = await batchResolveFileSizes('COMMENT_FILE', allFileIds)

    // Attach resolved sizes to each file object
    for (const comment of comments as any[]) {
      for (const f of (comment.files || [])) {
        f.fileSize = commentFileSizeMap.get(f.id) ?? 0
      }
      for (const reply of (comment.replies || [])) {
        for (const f of (reply.files || [])) {
          f.fileSize = commentFileSizeMap.get(f.id) ?? 0
        }
      }
    }

    // Resolve which comment authors actually have an avatar, so we don't emit avatar URLs
    // (and 404s) for users on default initials.
    const authorUserIds = [...new Set(
      comments
        .flatMap((c: any) => [c.userId, ...((c.replies || []).map((r: any) => r.userId))])
        .filter((id: any): id is string => typeof id === 'string' && id.length > 0),
    )]
    const usersWithAvatar = await getUserIdsWithAvatar(authorUserIds)

    // Sanitize comments - never expose PII to non-admins
    const sanitizedComments = comments.map((comment: any) => sanitizeComment(
      comment,
      isAdmin,
      isAuthenticated,
      fallbackName,
      usersWithAvatar,
    ))

    return NextResponse.json(sanitizedComments, { headers: noStoreHeaders })
  } catch (error) {
    console.error('Error fetching comments:', error)
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500, headers: noStoreHeaders }
    )
  }
}
