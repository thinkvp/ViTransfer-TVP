import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { getUserPasskeys } from '@/lib/passkey'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { canDoAction, canSeeMenu } from '@/lib/rbac'
export const runtime = 'nodejs'




/**
 * List User's PassKeys
 *
 * GET /api/auth/passkey/list[?userId=<id>]
 *
 * SECURITY:
 * - Requires admin authentication (JWT)
 * - Defaults to the current user's passkeys
 * - Another user's passkeys require the Users menu + manageUsers action
 *
 * Returns:
 * - Array of passkeys with metadata (no sensitive crypto material)
 */
export async function GET(request: NextRequest) {
  try {
    // Require admin authentication
    const user = await requireApiUser(request)
    if (user instanceof Response) return user

    const requestedUserId = request.nextUrl.searchParams.get('userId')?.trim() || ''
    const targetUserId = requestedUserId || user.id

    if (targetUserId !== user.id) {
      // Listing someone else's passkeys is a user-administration operation.
      const permissions = getUserPermissions(user)
      if (!canSeeMenu(permissions, 'users') || !canDoAction(permissions, 'manageUsers')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } else {
      const forbiddenMenu = requireMenuAccess(user, 'settings')
      if (forbiddenMenu) return forbiddenMenu

      const forbiddenAction = requireActionAccess(user, 'changeSettings')
      if (forbiddenAction) return forbiddenAction
    }

    // Rate limiting: 60 requests per minute
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.'
    }, 'passkey-list')

    if (rateLimitResult) {
      return rateLimitResult
    }

    // Get the target user's passkeys
    const passkeys = await getUserPasskeys(targetUserId)

    const response = NextResponse.json({ passkeys })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[PASSKEY] List error:', error)

    return NextResponse.json(
      { error: 'Failed to retrieve passkeys' },
      { status: 500 }
    )
  }
}
