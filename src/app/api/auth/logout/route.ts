import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { getCurrentUserFromRequest, parseBearerToken, revokePresentedTokens } from '@/lib/auth'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

/**
 * Stateless logout
 *
 * Expects:
 * - Authorization: Bearer <accessToken> (optional but revoked if present)
 * - X-Refresh-Token: Bearer <refreshToken> OR JSON body { refreshToken }
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many logout attempts. Please try again later.'
    }, 'logout')
    if (rateLimitResult) return rateLimitResult

    const user = await getCurrentUserFromRequest(request)
    const accessToken = parseBearerToken(request)
    const refreshToken = await extractRefreshToken(request)

    await revokePresentedTokens({ accessToken, refreshToken })

    logSecurityEvent({
      type: 'ADMIN_SESSION_LOGOUT',
      severity: 'INFO',
      ipAddress: getClientIpAddress(request),
      details: {
        userId: user?.id,
        email: user?.email,
      },
    }).catch(() => {})

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Logout error:', error)
    return NextResponse.json({ success: true })
  }
}

async function extractRefreshToken(request: NextRequest): Promise<string | null> {
  let token = request.headers.get('x-refresh-token')
  if (token?.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7)
  }
  if (token) return token

  try {
    const parsed = await request.json()
    return parsed?.refreshToken || null
  } catch {
    return null
  }
}
