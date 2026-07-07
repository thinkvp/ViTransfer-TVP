import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { testEmailConnection } from '@/lib/email'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require admin authentication
    const authResult = await requireApiUser(request)
    if (authResult instanceof Response) {
      return authResult
    }

    const forbiddenMenu = requireMenuAccess(authResult, 'settings')
    if (forbiddenMenu) return forbiddenMenu

    const forbiddenAction = requireActionAccess(authResult, 'sendTestEmail')
    if (forbiddenAction) return forbiddenAction

    // SECURITY: Rate-limit to prevent email-bomb relay (5 per minute per IP)
    const rateLimitResult = await rateLimit(
      request,
      { windowMs: 60 * 1000, maxRequests: 5, message: 'Too many test email requests. Please slow down.' },
      'settings-test-email'
    )
    if (rateLimitResult) return rateLimitResult

    const { testEmail, smtpConfig } = await request.json()

    if (!testEmail) {
      return NextResponse.json(
        { error: 'Test email address is required' },
        { status: 400 }
      )
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(testEmail)) {
      return NextResponse.json(
        { error: 'Invalid email address format' },
        { status: 400 }
      )
    }

    // Write-only secret: the browser no longer holds the saved SMTP password. If the admin
    // is testing without typing a new one, fall back to the stored (decrypted) password so a
    // test still exercises the real credentials. The plaintext never leaves the server.
    if (smtpConfig && (!smtpConfig.smtpPassword || String(smtpConfig.smtpPassword).trim() === '')) {
      const stored = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { smtpPassword: true },
      })
      smtpConfig.smtpPassword = stored?.smtpPassword ? decrypt(stored.smtpPassword) : null
    }

    // Test email connection and send test email with provided config or saved config
    const result = await testEmailConnection(testEmail, smtpConfig)

    const response = NextResponse.json(result)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error: any) {
    let errorMessage = 'Failed to send test email'

    // Provide generic error messages without exposing config details
    if (error.message?.includes('SMTP settings are not configured')) {
      errorMessage = 'SMTP settings are not configured. Please configure email settings first.'
    } else if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed. Please check your SMTP credentials.'
    } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Could not connect to SMTP server. Please check your settings.'
    }

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
