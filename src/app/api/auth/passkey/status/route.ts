import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { getPasskeyConfigStatus } from '@/lib/settings'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'




/**
 * Get PassKey Configuration Status
 *
 * GET /api/auth/passkey/status
 *
 * SECURITY:
 * - Requires admin authentication
 * - Returns detailed config status for admin UI
 *
 * Returns:
 * - available: boolean
 * - reason?: string (if not available)
 * - config?: { domain, httpsEnabled, isLocalhost }
 */
export async function GET(request: NextRequest) {
  try {
    // Require admin authentication
    const user = await requireApiAdmin(request)
    if (user instanceof Response) return user

    const forbiddenMenu = requireMenuAccess(user, 'settings')
    if (forbiddenMenu) return forbiddenMenu

    const forbiddenAction = requireActionAccess(user, 'changeSettings')
    if (forbiddenAction) return forbiddenAction

    // Rate limiting: 60 requests per minute
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.'
    }, 'passkey-status')

    if (rateLimitResult) {
      return rateLimitResult
    }

    // Get passkey configuration status
    const status = await getPasskeyConfigStatus()

    const response = NextResponse.json(status)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[PASSKEY] Status check error:', error)

    return NextResponse.json(
      {
        available: false,
        reason: 'Failed to check passkey configuration',
      },
      { status: 500 }
    )
  }
}
