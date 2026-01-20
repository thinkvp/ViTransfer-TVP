import { NextRequest, NextResponse } from 'next/server'
import { requestPasswordReset, checkResetRateLimit } from '@/lib/password-reset'
import { isSmtpConfigured, getEmailSettings } from '@/lib/email'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { sendPushNotification } from '@/lib/push-notifications'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Forgot Password API Endpoint
 *
 * POST /api/auth/forgot-password
 *
 * SECURITY FEATURES:
 * 1. Rate limiting per email address (3 requests per hour)
 * 2. Always returns success to prevent user enumeration
 * 3. Input validation with Zod
 * 4. SMTP configuration check before processing
 * 5. Security event logging for audit trail
 * 6. Generic error messages to prevent information disclosure
 * 7. Email format validation
 */

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .min(1, 'Email is required')
    .max(255, 'Email is too long')
    .email('Invalid email format')
    .transform((e) => e.toLowerCase().trim()),
})

export async function POST(request: NextRequest) {
  const ipAddress = getClientIpAddress(request)

  try {
    // Parse and validate request body
    const body = await request.json()
    const validation = forgotPasswordSchema.safeParse(body)

    if (!validation.success) {
      // SECURITY: Return generic success even for invalid input
      // to prevent email format enumeration
      return NextResponse.json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
      })
    }

    const { email } = validation.data

    // Check rate limit before any processing
    const rateLimit = await checkResetRateLimit(email)
    if (rateLimit.limited) {
      // Log rate limit hit
      await logSecurityEvent({
        type: 'PASSWORD_RESET_RATE_LIMIT_HIT',
        severity: 'WARNING',
        ipAddress,
        details: {
          email: email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially redact email
          retryAfter: rateLimit.retryAfter,
        },
        wasBlocked: true,
      })

      // SECURITY: Still return success to prevent enumeration
      return NextResponse.json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
      })
    }

    // Check if SMTP is configured
    const smtpConfigured = await isSmtpConfigured()
    if (!smtpConfigured) {
      // Log the issue for admins
      console.error('[FORGOT_PASSWORD] SMTP not configured')

      // Return 503 since this is a server configuration issue
      return NextResponse.json(
        {
          success: false,
          error: 'Email service is not configured. Please contact your administrator.',
        },
        { status: 503 }
      )
    }

    // Get APP_DOMAIN for reset URL
    const settings = await getEmailSettings()
    const appDomain = settings?.appDomain || process.env.APP_DOMAIN || ''

    if (!appDomain) {
      console.error('[FORGOT_PASSWORD] APP_DOMAIN not configured')
      return NextResponse.json(
        {
          success: false,
          error: 'Server configuration error. Please contact your administrator.',
        },
        { status: 500 }
      )
    }

    // Request password reset (handles user lookup, token generation, email sending)
    const result = await requestPasswordReset(email, appDomain)

    // Log the reset request (without revealing if user exists)
    await logSecurityEvent({
      type: 'PASSWORD_RESET_REQUESTED',
      severity: 'INFO',
      ipAddress,
      details: {
        email: email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially redact email
      },
      wasBlocked: false,
    })

    // Send push notification for password reset request
    // SECURITY: Don't reveal if user exists in the notification
    await sendPushNotification({
      type: 'PASSWORD_RESET_REQUESTED',
      title: 'Password Reset Requested',
      message: 'A password reset link was requested',
      details: {
        'Email': email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially redact
        'IP Address': ipAddress,
      },
    })

    // SECURITY: Always return success to prevent user enumeration
    return NextResponse.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    })
  } catch (error) {
    // Log the error internally
    console.error('[FORGOT_PASSWORD] Error:', error)

    // Log as security event
    await logSecurityEvent({
      type: 'PASSWORD_RESET_ERROR',
      severity: 'WARNING',
      ipAddress,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      wasBlocked: false,
    })

    // SECURITY: Return generic success even on errors to prevent enumeration
    return NextResponse.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    })
  }
}
