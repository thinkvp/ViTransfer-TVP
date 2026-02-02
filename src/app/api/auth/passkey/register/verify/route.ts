import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { verifyPasskeyRegistration } from '@/lib/passkey'
import { getClientIpAddress } from '@/lib/utils'
import type { RegistrationResponseJSON } from '@simplewebauthn/browser'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'




/**
 * Verify PassKey Registration Response
 *
 * POST /api/auth/passkey/register/verify
 *
 * SECURITY:
 * - Requires admin authentication (JWT)
 * - Retrieves and DELETES challenge from Redis (one-time use)
 * - Verifies WebAuthn response signature
 * - Stores credential in database
 * - Tracks IP and user agent for security
 *
 * Body:
 * - response: RegistrationResponseJSON from @simplewebauthn/browser
 *
 * Returns:
 * - { success: true, credentialId: string } on success
 * - { success: false, error: string } on failure
 */
export async function POST(request: NextRequest) {
  try {
    // Require admin authentication
    const user = await requireApiUser(request)
    if (user instanceof Response) return user

    const forbiddenMenu = requireMenuAccess(user, 'settings')
    if (forbiddenMenu) return forbiddenMenu

    const forbiddenAction = requireActionAccess(user, 'changeSettings')
    if (forbiddenAction) return forbiddenAction

    // Parse request body
    const body = await request.json()
    const registrationResponse = body as RegistrationResponseJSON

    if (!registrationResponse || !registrationResponse.id) {
      return NextResponse.json(
        { success: false, error: 'Invalid registration response' },
        { status: 400 }
      )
    }

    // Get client info for security tracking
    const userAgent = request.headers.get('user-agent') || undefined
    const ipAddress = getClientIpAddress(request)

    // Verify registration
    const result = await verifyPasskeyRegistration(
      user,
      registrationResponse,
      userAgent,
      ipAddress
    )

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      )
    }

    const response = NextResponse.json({
      success: true,
      credentialId: result.credentialId,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[PASSKEY] Registration verification error:', error)

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to verify PassKey registration',
      },
      { status: 500 }
    )
  }
}
