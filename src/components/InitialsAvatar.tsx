import { cn } from '@/lib/utils'

function getUserInitials(name?: string | null, email?: string | null): string {
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

export function InitialsAvatar(props: {
  name?: string | null
  email?: string | null
  displayColor?: string | null
  className?: string
  title?: string
}) {
  const { name, email, displayColor, className, title } = props

  const initials = getUserInitials(name, email)
  const bg = typeof displayColor === 'string' && displayColor.trim() ? displayColor : '#64748b'
  const label = (title ?? String(name || email || '').trim()) || 'Recipient'

  return (
    <div
      className={cn(
        'h-7 w-7 rounded-full ring-2 ring-background flex items-center justify-center text-[11px] font-semibold uppercase select-none flex-shrink-0',
        className
      )}
      style={{ backgroundColor: bg, color: '#fff' }}
      title={label}
      aria-label={label}
    >
      {initials}
    </div>
  )
}
