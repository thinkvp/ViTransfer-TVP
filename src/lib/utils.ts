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

  // European format (dd-MM-yyyy)
  if (timezone.startsWith('Europe/') || timezone.startsWith('Africa/')) {
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

export function getClientIpAddress(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
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
