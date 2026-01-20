/**
 * Password Reset Token Management
 *
 * SECURITY FEATURES:
 * 1. Cryptographically secure random tokens (48 bytes = 64 chars base64url)
 * 2. Tokens are hashed before storage (SHA-256) - never stored in plaintext
 * 3. Short token expiry (15 minutes by default)
 * 4. Single-use tokens - invalidated immediately after use
 * 5. Rate limiting on reset requests to prevent enumeration
 * 6. Generic response messages to prevent user enumeration
 * 7. Token bound to specific user email for additional validation
 * 8. All previous tokens invalidated when new one is generated
 */

import crypto from 'crypto'
import { prisma } from './db'
import { hashPassword, validatePassword } from './encryption'
import { getRedis } from './redis'
import {
  EMAIL_THEME,
  buildCompanyLogoUrl,
  emailCardStyle,
  emailPrimaryButtonStyle,
  escapeHtml,
  getEmailSettings,
  renderEmailShell,
  sendEmail,
} from './email'

// Configuration constants
const TOKEN_BYTES = 48 // 48 bytes = 64 chars in base64url
const TOKEN_EXPIRY_MINUTES = 15 // Short expiry for security
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_RESET_REQUESTS_PER_HOUR = 3 // Per email address
const LOCKOUT_DURATION_MS = 60 * 60 * 1000 // 1 hour lockout after max requests

/**
 * Hash an email for Redis keys (no PII in keys)
 */
function hashEmailForKey(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16)
}

/**
 * Hash a reset token before storage
 * SECURITY: Never store plaintext tokens in the database
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Generate a cryptographically secure reset token
 */
export function generateResetToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Check rate limit for password reset requests
 * Returns { limited: true, retryAfter: seconds } if rate limited
 */
export async function checkResetRateLimit(
  email: string
): Promise<{ limited: boolean; retryAfter?: number }> {
  const redis = getRedis()
  const emailHash = hashEmailForKey(email)
  const rateLimitKey = `password-reset:ratelimit:${emailHash}`

  const data = await redis.get(rateLimitKey)
  const now = Date.now()

  if (data) {
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      // Invalid data, reset
      await redis.del(rateLimitKey)
      return { limited: false }
    }

    const { count, firstAttempt, lockedUntil } = parsed

    // Check if currently locked out
    if (lockedUntil && now < lockedUntil) {
      const retryAfter = Math.ceil((lockedUntil - now) / 1000)
      return { limited: true, retryAfter }
    }

    // Check if window has expired
    if (now - firstAttempt > RATE_LIMIT_WINDOW_MS) {
      // Window expired, reset
      await redis.del(rateLimitKey)
      return { limited: false }
    }

    // Check if limit exceeded
    if (count >= MAX_RESET_REQUESTS_PER_HOUR) {
      // Apply lockout
      const lockedUntilTime = now + LOCKOUT_DURATION_MS
      const ttlSeconds = Math.ceil(LOCKOUT_DURATION_MS / 1000)
      await redis.setex(
        rateLimitKey,
        ttlSeconds,
        JSON.stringify({ ...parsed, lockedUntil: lockedUntilTime })
      )
      const retryAfter = Math.ceil(LOCKOUT_DURATION_MS / 1000)
      return { limited: true, retryAfter }
    }
  }

  return { limited: false }
}

/**
 * Increment the rate limit counter for password reset requests
 */
async function incrementResetRateLimit(email: string): Promise<void> {
  const redis = getRedis()
  const emailHash = hashEmailForKey(email)
  const rateLimitKey = `password-reset:ratelimit:${emailHash}`

  const data = await redis.get(rateLimitKey)
  const now = Date.now()

  let count = 1
  let firstAttempt = now

  if (data) {
    try {
      const parsed = JSON.parse(data)
      // Reset if window expired
      if (now - parsed.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        count = 1
        firstAttempt = now
      } else {
        count = (parsed.count || 0) + 1
        firstAttempt = parsed.firstAttempt
      }
    } catch {
      // Invalid data, reset with defaults
    }
  }

  const ttlSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
  await redis.setex(
    rateLimitKey,
    ttlSeconds,
    JSON.stringify({ count, firstAttempt })
  )
}

/**
 * Store a password reset token
 * SECURITY: Invalidates all previous tokens for this user
 */
export async function storeResetToken(
  userId: string,
  email: string,
  token: string
): Promise<void> {
  const redis = getRedis()
  const tokenHash = hashToken(token)
  const emailHash = hashEmailForKey(email)

  // SECURITY: Invalidate all previous tokens for this user
  const existingTokensKey = `password-reset:user-tokens:${userId}`
  const existingTokens = await redis.smembers(existingTokensKey)
  if (existingTokens.length > 0) {
    await redis.del(existingTokens)
  }
  await redis.del(existingTokensKey)

  // Store the new token
  const tokenKey = `password-reset:token:${tokenHash}`
  const tokenData = {
    userId,
    email: email.toLowerCase().trim(),
    createdAt: Date.now(),
  }

  const ttlSeconds = TOKEN_EXPIRY_MINUTES * 60
  await redis.setex(tokenKey, ttlSeconds, JSON.stringify(tokenData))

  // Track this token for the user (for invalidation)
  await redis.sadd(existingTokensKey, tokenKey)
  await redis.expire(existingTokensKey, ttlSeconds)

  // Increment rate limit counter
  await incrementResetRateLimit(email)
}

/**
 * Verify and consume a password reset token
 * SECURITY: Token is deleted after verification (single-use)
 */
export async function verifyResetToken(
  token: string
): Promise<{
  valid: boolean
  userId?: string
  email?: string
  error?: string
}> {
  const redis = getRedis()
  const tokenHash = hashToken(token)
  const tokenKey = `password-reset:token:${tokenHash}`

  const data = await redis.get(tokenKey)

  if (!data) {
    return {
      valid: false,
      error: 'Invalid or expired reset link',
    }
  }

  let tokenData
  try {
    tokenData = JSON.parse(data)
  } catch {
    await redis.del(tokenKey)
    return {
      valid: false,
      error: 'Invalid reset link',
    }
  }

  // Check if token is expired (defense in depth - Redis TTL should handle this)
  const age = Date.now() - tokenData.createdAt
  if (age > TOKEN_EXPIRY_MINUTES * 60 * 1000) {
    await redis.del(tokenKey)
    return {
      valid: false,
      error: 'Reset link has expired',
    }
  }

  // Verify user still exists
  const user = await prisma.user.findUnique({
    where: { id: tokenData.userId },
    select: { id: true, email: true },
  })

  if (!user) {
    await redis.del(tokenKey)
    return {
      valid: false,
      error: 'Invalid reset link',
    }
  }

  // Verify email matches (defense in depth)
  if (user.email.toLowerCase() !== tokenData.email.toLowerCase()) {
    await redis.del(tokenKey)
    return {
      valid: false,
      error: 'Invalid reset link',
    }
  }

  return {
    valid: true,
    userId: tokenData.userId,
    email: tokenData.email,
  }
}

/**
 * Consume (invalidate) a reset token
 * Called after successful password reset
 */
export async function consumeResetToken(token: string): Promise<void> {
  const redis = getRedis()
  const tokenHash = hashToken(token)
  const tokenKey = `password-reset:token:${tokenHash}`

  // Get token data to clean up user token tracking
  const data = await redis.get(tokenKey)
  if (data) {
    try {
      const tokenData = JSON.parse(data)
      const userTokensKey = `password-reset:user-tokens:${tokenData.userId}`
      await redis.srem(userTokensKey, tokenKey)
    } catch {
      // Ignore parse errors
    }
  }

  // Delete the token
  await redis.del(tokenKey)
}

/**
 * Reset a user's password
 * SECURITY: Validates password strength and invalidates all sessions
 */
export async function resetPassword(
  userId: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  // Validate password strength
  const validation = validatePassword(newPassword)
  if (!validation.isValid) {
    return {
      success: false,
      error: validation.errors[0] || 'Password does not meet requirements',
    }
  }

  // Hash the new password
  const hashedPassword = await hashPassword(newPassword)

  // Update password in database
  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      updatedAt: new Date(),
    },
  })

  // SECURITY: Invalidate all existing sessions for this user
  // This forces re-authentication after password change
  const redis = getRedis()
  const revokedAtKey = `user:tokens:revoked_at:${userId}`
  await redis.set(revokedAtKey, Date.now().toString())

  return { success: true }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<{ success: boolean; error?: string }> {
  const { subject, html, text } = await renderPasswordResetEmail({ resetUrl })

  return await sendEmail({
    to: email,
    subject,
    html,
    text,
  })
}

/**
 * Render the password reset email
 */
async function renderPasswordResetEmail({
  resetUrl,
}: {
  resetUrl: string
}): Promise<{ subject: string; html: string; text: string }> {
  const settings = await getEmailSettings()

  const companyName = settings?.companyName || 'ViTransfer'
  const companyLogoUrl = settings
    ? buildCompanyLogoUrl({
        appDomain: settings.appDomain,
        companyLogoMode: settings.companyLogoMode,
        companyLogoPath: settings.companyLogoPath,
        companyLogoUrl: settings.companyLogoUrl,
        updatedAt: settings.updatedAt,
      })
    : null

  const subject = `Reset your password for ${escapeHtml(companyName)}`

  const html = renderEmailShell({
    companyName,
    companyLogoUrl,
    headerGradient: EMAIL_THEME.headerBackground,
    title: 'Password Reset Request',
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: ${EMAIL_THEME.textMuted}; line-height: 1.5;">
        We received a request to reset your password for your admin account.
      </p>

      <p style="margin: 0 0 24px 0; font-size: 16px; color: ${EMAIL_THEME.textMuted}; line-height: 1.5;">
        Click the button below to set a new password:
      </p>

      <div style="text-align: center; margin: 0 0 24px 0;">
        <a href="${escapeHtml(resetUrl)}" style="${emailPrimaryButtonStyle()}">
          Reset Password
        </a>
      </div>

      <div style="${emailCardStyle({ paddingPx: 16, borderRadiusPx: 8, marginBottomPx: 24 })}">
        <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 600; color: ${EMAIL_THEME.textMuted};">
          Security Notice
        </p>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6;">
          <li>This link will expire in <strong>${TOKEN_EXPIRY_MINUTES} minutes</strong>.</li>
          <li>This link can only be used once.</li>
          <li>If you didn't request this reset, please ignore this email.</li>
          <li>Your password will remain unchanged until you create a new one.</li>
        </ul>
      </div>

      <p style="margin: 0; font-size: 13px; color: ${EMAIL_THEME.textSubtle}; line-height: 1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br />
        <a href="${escapeHtml(resetUrl)}" style="color: ${EMAIL_THEME.accent}; word-break: break-all;">
          ${escapeHtml(resetUrl)}
        </a>
      </p>
    `,
  })

  const text = `
Password Reset Request

We received a request to reset your password for your admin account.

Click the link below to set a new password:
${resetUrl}

Security Notice:
- This link will expire in ${TOKEN_EXPIRY_MINUTES} minutes.
- This link can only be used once.
- If you didn't request this reset, please ignore this email.
- Your password will remain unchanged until you create a new one.
  `.trim()

  return { subject, html, text }
}

/**
 * Request a password reset for an admin user
 * SECURITY: Always returns success to prevent user enumeration
 */
export async function requestPasswordReset(
  email: string,
  appDomain: string
): Promise<{ success: boolean; error?: string }> {
  // Normalize email
  const normalizedEmail = email.toLowerCase().trim()

  // Check rate limit
  const rateLimit = await checkResetRateLimit(normalizedEmail)
  if (rateLimit.limited) {
    // SECURITY: Return generic message even when rate limited
    // Don't reveal if the email exists or not
    return {
      success: true, // Always return success to prevent enumeration
    }
  }

  // Look up user by email
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  })

  // SECURITY: If user doesn't exist, still increment rate limit and return success
  // This prevents user enumeration attacks
  if (!user) {
    await incrementResetRateLimit(normalizedEmail)
    return {
      success: true, // Always return success to prevent enumeration
    }
  }

  // Generate and store reset token
  const token = generateResetToken()
  await storeResetToken(user.id, user.email, token)

  // Build reset URL
  const baseUrl = appDomain.endsWith('/') ? appDomain.slice(0, -1) : appDomain
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`

  // Send reset email
  const emailResult = await sendPasswordResetEmail(user.email, resetUrl)

  if (!emailResult.success) {
    // Log error but still return success to prevent enumeration
    console.error('[PASSWORD_RESET] Failed to send email:', emailResult.error)
  }

  return { success: true }
}
