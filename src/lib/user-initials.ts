export function getUserInitials(name?: string | null, email?: string | null): string {
  const cleanedName = String(name || '').trim()

  const normalizeToken = (token: string) => token.replace(/[^\p{L}\p{N}]+/gu, '')

  const nameTokens = cleanedName
    ? cleanedName
        .split(/\s+/)
        .map((t) => normalizeToken(t))
        .filter(Boolean)
    : []

  if (nameTokens.length >= 2) {
    return `${nameTokens[0][0] || ''}${nameTokens[nameTokens.length - 1][0] || ''}`.toUpperCase()
  }

  if (nameTokens.length === 1) {
    const token = nameTokens[0]
    const first = token[0] || ''
    const second = token[1] || ''
    return `${first}${second}`.toUpperCase()
  }

  const localPart = String(email || '').split('@')[0] || ''
  const emailTokens = localPart
    ? localPart
        .split(/[._\-\s]+/)
        .map((t) => normalizeToken(t))
        .filter(Boolean)
    : []

  if (emailTokens.length >= 2) {
    return `${emailTokens[0][0] || ''}${emailTokens[emailTokens.length - 1][0] || ''}`.toUpperCase()
  }

  if (emailTokens.length === 1) {
    const token = emailTokens[0]
    const first = token[0] || ''
    const second = token[1] || ''
    return `${first}${second}`.toUpperCase()
  }

  return '--'
}
