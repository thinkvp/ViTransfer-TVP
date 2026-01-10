import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { generatePasskeyRegistrationOptions } from '@/lib/passkey'
import { isPasskeyConfigured } from '@/lib/settings'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'




/**
 * Generate PassKey Registration Options
 *
 * POST /api/auth/passkey/register/options
 *
 * SECURITY:
 * - Requires admin authentication (JWT)
 * - Checks if PassKey is configured (appDomain in Settings)
 * - Generates challenge and stores in Redis (5-min TTL)
 * - Challenge is one-time use (deleted after verification)
 *
 * Returns:
 * - PublicKeyCredentialCreationOptions for browser
 */
export async function POST(request: NextRequest) {
  try {
    // Require admin authentication
    const user = await requireApiAdmin(request)
    if (user instanceof Response) return user

    const forbiddenMenu = requireMenuAccess(user, 'settings')
    if (forbiddenMenu) return forbiddenMenu

    const forbiddenAction = requireActionAccess(user, 'changeSettings')
    if (forbiddenAction) return forbiddenAction

    // Check if PassKey is configured
    const configured = await isPasskeyConfigured()
    if (!configured) {
      return NextResponse.json(
        {
          error:
            'PassKey authentication is not configured. Please set your domain in Settings first.',
        },
        { status: 503 }
      )
    }

    // Generate registration options
    const options = await generatePasskeyRegistrationOptions(user)

    const response = NextResponse.json(options)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[PASSKEY] Registration options error:', error)

    // Return user-friendly error
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message.includes('PASSKEY_CONFIG_ERROR')
            ? error.message.replace('PASSKEY_CONFIG_ERROR: ', '')
            : 'Failed to generate PassKey registration options',
      },
      { status: 500 }
    )
  }
}
