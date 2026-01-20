import { NextRequest, NextResponse } from 'next/server'
import {
  verifyResetToken,
  consumeResetToken,
  resetPassword,
} from '@/lib/password-reset'
import { validatePassword } from '@/lib/encryption'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { sendPushNotification } from '@/lib/push-notifications'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reset Password API Endpoint
 *
 * POST /api/auth/reset-password
 *
 * SECURITY FEATURES:
 * 1. Token verification with constant-time comparison
 * 2. Single-use tokens (consumed after use)
 * 3. Password strength validation
 * 4. All existing sessions invalidated after reset
 * 5. Security event logging for audit trail
 * 6. Generic error messages to prevent token enumeration
 * 7. Input validation with Zod
 */

const resetPasswordSchema = z.object({
  token: z
    .string()
    .min(1, 'Reset token is required')
    .max(256, 'Invalid token'), // Base64url encoded 48 bytes = ~64 chars
  password: z.string().min(1, 'Password is required'),
  confirmPassword: z.string().min(1, 'Password confirmation is required'),
})

export async function POST(request: NextRequest) {
  const ipAddress = getClientIpAddress(request)

  try {
    // Parse and validate request body
    const body = await request.json()
    const validation = resetPasswordSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request. Please check your input.',
        },
        { status: 400 }
      )
    }

    const { token, password, confirmPassword } = validation.data

    // Check passwords match
    if (password !== confirmPassword) {
      return NextResponse.json(
        {
          success: false,
          error: 'Passwords do not match.',
        },
        { status: 400 }
      )
    }

    // Validate password strength
    const passwordValidation = validatePassword(password)
    if (!passwordValidation.isValid) {
      return NextResponse.json(
        {
          success: false,
          error: passwordValidation.errors[0] || 'Password does not meet requirements.',
          details: passwordValidation.errors,
        },
        { status: 400 }
      )
    }

    // Verify the reset token
    const tokenResult = await verifyResetToken(token)

    if (!tokenResult.valid) {
      // Log failed reset attempt
      await logSecurityEvent({
        type: 'PASSWORD_RESET_TOKEN_INVALID',
        severity: 'WARNING',
        ipAddress,
        details: {
          error: tokenResult.error,
        },
        wasBlocked: true,
      })

      return NextResponse.json(
        {
          success: false,
          error: tokenResult.error || 'Invalid or expired reset link. Please request a new one.',
        },
        { status: 400 }
      )
    }

    // Reset the password
    const resetResult = await resetPassword(tokenResult.userId!, password)

    if (!resetResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: resetResult.error || 'Failed to reset password. Please try again.',
        },
        { status: 400 }
      )
    }

    // Consume (invalidate) the token after successful reset
    await consumeResetToken(token)

    // Log successful password reset
    await logSecurityEvent({
      type: 'PASSWORD_RESET_SUCCESS',
      severity: 'INFO',
      ipAddress,
      details: {
        userId: tokenResult.userId,
        email: tokenResult.email?.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially redact
      },
      wasBlocked: false,
    })

    // Send push notification for successful password reset
    // SECURITY: Important security event - notify admin
    await sendPushNotification({
      type: 'PASSWORD_RESET_SUCCESS',
      title: 'Password Changed',
      message: 'An admin user password was successfully reset',
      details: {
        'Email': tokenResult.email?.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially redact
        'IP Address': ipAddress,
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Your password has been reset successfully. You can now log in with your new password.',
    })
  } catch (error) {
    // Log the error internally
    console.error('[RESET_PASSWORD] Error:', error)

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

    return NextResponse.json(
      {
        success: false,
        error: 'An error occurred. Please try again or request a new reset link.',
      },
      { status: 500 }
    )
  }
}

/**
 * Verify Token API Endpoint (for client-side token validation)
 *
 * GET /api/auth/reset-password?token=xxx
 *
 * Used to validate a token before showing the reset form
 */
export async function GET(request: NextRequest) {
  const ipAddress = getClientIpAddress(request)

  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json(
        {
          valid: false,
          error: 'Reset token is required.',
        },
        { status: 400 }
      )
    }

    // Validate token length
    if (token.length > 256) {
      return NextResponse.json(
        {
          valid: false,
          error: 'Invalid reset link.',
        },
        { status: 400 }
      )
    }

    // Verify the token (without consuming it)
    const result = await verifyResetToken(token)

    if (!result.valid) {
      return NextResponse.json({
        valid: false,
        error: result.error || 'Invalid or expired reset link.',
      })
    }

    // Return success without revealing user details
    return NextResponse.json({
      valid: true,
    })
  } catch (error) {
    console.error('[VERIFY_RESET_TOKEN] Error:', error)

    return NextResponse.json(
      {
        valid: false,
        error: 'An error occurred. Please try again.',
      },
      { status: 500 }
    )
  }
}
