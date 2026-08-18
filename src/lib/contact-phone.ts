/**
 * Contact phone numbers (client contacts / project recipients).
 *
 * Deliberately permissive-but-narrow: digits, spaces and a leading-style '+'
 * only, capped at 20 characters. Free-form enough for international formats
 * without becoming a notes field.
 */

export const CONTACT_PHONE_MAX_LENGTH = 20

const CONTACT_PHONE_PATTERN = /^[0-9+ ]+$/

export function isContactPhone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= CONTACT_PHONE_MAX_LENGTH && CONTACT_PHONE_PATTERN.test(trimmed)
}

/**
 * Strip characters the field doesn't accept and enforce the length cap.
 * Used on every keystroke so the input can't hold an invalid value.
 */
export function sanitizeContactPhoneInput(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[^0-9+ ]/g, '').slice(0, CONTACT_PHONE_MAX_LENGTH)
}

/**
 * Normalize for storage: trimmed string, or null when empty/invalid.
 */
export function normalizeContactPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = sanitizeContactPhoneInput(value).trim()
  return trimmed ? trimmed : null
}
