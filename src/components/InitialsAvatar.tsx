'use client'

import Image from 'next/image'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'

// Matches the user-avatar endpoint URL so we can check existence before rendering the <img>.
const USER_AVATAR_URL_RE = /^\/api\/users\/([^/?#]+)\/avatar(?:[?#].*)?$/

// Module-level cache (deduped across every avatar instance): userId → Promise<hasAvatar>.
// Persists for the session; an avatar uploaded mid-session shows after the next reload.
const avatarExistsCache = new Map<string, Promise<boolean>>()
function checkUserAvatarExists(userId: string): Promise<boolean> {
  let p = avatarExistsCache.get(userId)
  if (!p) {
    p = fetch(`/api/users/${encodeURIComponent(userId)}/avatar/exists`)
      .then((r) => (r.ok ? r.json() : { exists: false }))
      .then((d) => d?.exists === true)
      .catch(() => false)
    avatarExistsCache.set(userId, p)
  }
  return p
}

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
  avatarUrl?: string | null
  className?: string
  title?: string
}) {
  const { name, email, displayColor, avatarUrl, className, title } = props

  const [imgError, setImgError] = useState(false)

  // For a user-avatar URL, confirm the avatar exists before rendering the <img>, so users on
  // default initials don't trigger a 404. Any other URL is used directly (legacy behaviour).
  const userId = avatarUrl ? (avatarUrl.match(USER_AVATAR_URL_RE)?.[1] ?? null) : null
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(
    avatarUrl && !userId ? avatarUrl : null,
  )
  useEffect(() => {
    setImgError(false)
    if (!avatarUrl) { setResolvedSrc(null); return }
    if (!userId) { setResolvedSrc(avatarUrl); return }
    let cancelled = false
    setResolvedSrc(null)
    checkUserAvatarExists(userId).then((exists) => {
      if (!cancelled) setResolvedSrc(exists ? avatarUrl : null)
    })
    return () => { cancelled = true }
  }, [avatarUrl, userId])

  const initials = getUserInitials(name, email)
  const bg = typeof displayColor === 'string' && displayColor.trim() ? displayColor : '#64748b'
  const label = (title ?? String(name || email || '').trim()) || 'Recipient'

  if (resolvedSrc && !imgError) {
    return (
      <Image
        src={resolvedSrc}
        alt={label}
        title={label}
        aria-label={label}
        width={28}
        height={28}
        unoptimized
        className={cn(
          'h-7 w-7 rounded-full ring-2 ring-card shadow-sm object-cover shrink-0',
          className,
        )}
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div
      className={cn(
        'h-7 w-7 rounded-full ring-2 ring-card shadow-sm flex items-center justify-center text-[11px] font-semibold uppercase select-none shrink-0',
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
