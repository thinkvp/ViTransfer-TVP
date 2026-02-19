import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment } from '@/lib/comment-sanitization'
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
        guestMode: true,
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

    const { isAdmin, isAuthenticated, isGuest } = accessCheck

    // Block guest users from seeing comments
    if (project.guestMode && isGuest) {
      return NextResponse.json([], { headers: noStoreHeaders })
    }

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
            fileSize: true,
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
                fileSize: true,
              }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    })

    // Sanitize comments - never expose PII to non-admins
    const sanitizedComments = comments.map((comment: any) => sanitizeComment(
      comment,
      isAdmin,
      isAuthenticated,
      fallbackName,
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
