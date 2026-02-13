import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { NextRequest } from 'next/server'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

export function formatTimestamp(seconds: number): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) {
    return '0:00'
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  // Show hours format for videos 60+ minutes
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  // Show minutes format for videos under 60 minutes
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/**
 * Format date with timezone awareness
 * Uses browser's timezone (client-side) or TZ env variable (server-side)
 * Format adapts based on detected timezone region
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  // Client-side: use browser timezone
  // Server-side: use TZ environment variable
  const timezone = typeof window !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : process.env.TZ!

  // Format date parts using Intl.DateTimeFormat with timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const parts = formatter.formatToParts(d)
  const year = parts.find(p => p.type === 'year')?.value || ''
  const month = parts.find(p => p.type === 'month')?.value || ''
  const day = parts.find(p => p.type === 'day')?.value || ''

  // US/Americas format (MM-dd-yyyy)
  if (timezone.startsWith('America/') || timezone.startsWith('US/')) {
    return `${month}-${day}-${year}`
  }

  // European/Australian format (dd-MM-yyyy)
  if (timezone.startsWith('Europe/') || timezone.startsWith('Africa/') || timezone.startsWith('Australia/')) {
    return `${day}-${month}-${year}`
  }

  // Asian/ISO format (yyyy-MM-dd) - also default
  return `${year}-${month}-${day}`
}

/**
 * Format date and time with timezone awareness
 * Uses browser's timezone (client-side) or TZ env variable (server-side)
 * Time is displayed in user's local timezone
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  // Client-side: use browser timezone
  // Server-side: use TZ environment variable
  const timezone = typeof window !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : process.env.TZ!

  const dateStr = formatDate(d)

  // Format time using Intl.DateTimeFormat with timezone
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false, // 24-hour format
  })

  const timeStr = timeFormatter.format(d)
  return `${dateStr} ${timeStr}`
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
}

function randomSlugSuffix(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const cryptoObj = globalThis.crypto
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Secure random generator not available')
  }

  const max = 256 - (256 % alphabet.length)
  let result = ''
  const bytes = new Uint8Array(Math.max(16, length * 2))

  while (result.length < length) {
    cryptoObj.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= max) continue
      result += alphabet[b % alphabet.length]
      if (result.length >= length) break
    }
  }

  return result
}

export async function generateUniqueSlug(
  title: string,
  prisma: any,
  excludeId?: string
): Promise<string> {
  const base = generateSlug(title) || 'project'

  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = `${base}-${randomSlugSuffix(8)}`

    const existing = await prisma.project.findUnique({
      where: { slug },
    })

    if (!existing || existing.id === excludeId) {
      return slug
    }
  }

  throw new Error('Unable to generate a unique share link. Please try again.')
}

// Cache parsed trusted proxies across requests (per Node process).
// Keyed by the raw env var value so changes cause a re-parse.
let trustedProxiesCache: { raw: string; matchers: unknown[] } | null = null

export function getClientIpAddress(request: NextRequest): string {
  const normalizeIp = (raw: string | null | undefined): string | null => {
    if (!raw) return null
    let s = String(raw).trim()
    if (!s) return null
    if (s.toLowerCase() === 'unknown') return null

    // Handle IPv6-with-port like "[::1]:1234"
    if (s.startsWith('[')) {
      const end = s.indexOf(']')
      if (end > 0) s = s.slice(1, end)
    } else {
      // Handle IPv4-with-port like "1.2.3.4:1234". Avoid breaking plain IPv6.
      const colonCount = (s.match(/:/g) || []).length
      if (colonCount === 1 && s.includes('.')) {
        s = s.split(':')[0].trim()
      }
    }

    // Normalize IPv4-mapped IPv6 (::ffff:192.168.0.1)
    const v4Mapped = s.toLowerCase().startsWith('::ffff:') ? s.slice(7) : null
    if (v4Mapped && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4Mapped)) {
      s = v4Mapped
    }

    return s || null
  }

  const parseXForwardedFor = (xff: string | null): string[] => {
    if (!xff) return []
    return xff
      .split(',')
      .map((p) => normalizeIp(p))
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
  }

  const isIpv4 = (ip: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)

  const ipv4ToInt = (ip: string): number | null => {
    if (!isIpv4(ip)) return null
    const parts = ip.split('.').map((x) => Number(x))
    if (parts.length !== 4) return null
    for (const n of parts) {
      if (!Number.isFinite(n) || n < 0 || n > 255) return null
    }
    // >>> 0 forces unsigned.
    return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0)
  }

  type TrustedProxyMatcher =
    | { kind: 'ipv4-cidr'; network: number; mask: number }
    | { kind: 'ip-exact'; ip: string; ipV4Int?: number }
  const getTrusted = (): TrustedProxyMatcher[] => {
    const raw = (process.env.TRUSTED_PROXIES || '').trim()
    if (trustedProxiesCache && trustedProxiesCache.raw === raw) {
      return trustedProxiesCache.matchers as TrustedProxyMatcher[]
    }

    const entries = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const matchers: TrustedProxyMatcher[] = []
    for (const e of entries) {
      if (e.includes('/')) {
        const [ipRaw, bitsRaw] = e.split('/')
        const ip = normalizeIp(ipRaw)
        const bits = Number(bitsRaw)
        const ipInt = ip ? ipv4ToInt(ip) : null
        if (ipInt == null) continue
        if (!Number.isFinite(bits) || bits < 0 || bits > 32) continue
        const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0)
        matchers.push({ kind: 'ipv4-cidr', network: (ipInt & mask) >>> 0, mask })
      } else {
        const ip = normalizeIp(e)
        if (!ip) continue
        const ipV4Int = ipv4ToInt(ip) ?? undefined
        matchers.push({ kind: 'ip-exact', ip, ipV4Int })
      }
    }

    trustedProxiesCache = { raw, matchers }
    return matchers
  }

  const isTrustedProxy = (ip: string, matchers: TrustedProxyMatcher[]): boolean => {
    if (!ip || matchers.length === 0) return false
    const ipInt = ipv4ToInt(ip)
    for (const m of matchers) {
      if (m.kind === 'ip-exact') {
        if (m.ip === ip) return true
        if (ipInt != null && m.ipV4Int != null && m.ipV4Int === ipInt) return true
      } else {
        if (ipInt == null) continue
        if (((ipInt & m.mask) >>> 0) === m.network) return true
      }
    }
    return false
  }

  const xff = request.headers.get('x-forwarded-for')
  const chain = parseXForwardedFor(xff)
  const realIp = normalizeIp(request.headers.get('x-real-ip'))

  const trusted = getTrusted()
  if (trusted.length > 0 && chain.length > 0) {
    // XFF is client,proxy1,proxy2,... (each proxy appends). With a trust list,
    // peel trusted proxies from the right and take the first non-trusted.
    for (let i = chain.length - 1; i >= 0; i--) {
      const ip = chain[i]
      if (isTrustedProxy(ip, trusted)) continue
      return ip
    }
    // All entries are trusted proxies; fall back to left-most.
    return chain[0] || realIp || 'unknown'
  }

  return chain[0] || realIp || 'unknown'
}

/**
 * Generate a consistent vibrant border color for a user based on their name
 * Returns border color class for left border on message bubbles
 * @param name - User's name for color generation
 * @param isSender - True if this is the sender (your message), false for receiver
 */
export function getUserColor(name: string | null | undefined, isSender: boolean = false): { border: string } {
  if (!name) {
    // Default gray for anonymous
    return { border: 'border-gray-500' }
  }

  // Simple hash function
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
    hash = hash & hash // Convert to 32bit integer
  }

  // Separate color palettes - sender and receiver NEVER share colors
  const senderColors = [
    // Earth tones for sender (beige, brown, army green)
    { border: 'border-amber-700' },
    { border: 'border-orange-800' },
    { border: 'border-stone-600' },
    { border: 'border-yellow-700' },
    { border: 'border-lime-700' },
    { border: 'border-green-700' },
    { border: 'border-emerald-800' },
    { border: 'border-teal-800' },
    { border: 'border-slate-600' },
    { border: 'border-zinc-600' },
  ]

  const receiverColors = [
    // Vibrant high-contrast colors for receiver
    { border: 'border-red-500' },
    { border: 'border-orange-500' },
    { border: 'border-amber-500' },
    { border: 'border-yellow-400' },
    { border: 'border-lime-500' },
    { border: 'border-green-500' },
    { border: 'border-emerald-500' },
    { border: 'border-pink-500' },
    { border: 'border-rose-500' },
    { border: 'border-fuchsia-500' },
  ]

  const colors = isSender ? senderColors : receiverColors

  // Use hash to pick a color
  const colorIndex = Math.abs(hash) % colors.length
  return colors[colorIndex]
}
