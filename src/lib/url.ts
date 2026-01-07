import { prisma } from './db'
import { NextRequest } from 'next/server'
import { headers } from 'next/headers'

function firstForwardedValue(value: string | null): string | null {
  if (!value) return null
  const first = value.split(',')[0]?.trim()
  return first || null
}

function normalizeProto(value: string | null, fallback: 'http' | 'https'): 'http' | 'https' {
  const proto = firstForwardedValue(value)?.toLowerCase()
  return proto === 'https' ? 'https' : proto === 'http' ? 'http' : fallback
}

function normalizeHost(value: string | null): string | null {
  const host = firstForwardedValue(value)
  if (!host) return null

  // Disallow whitespace, slashes, and CRLF to prevent header injection.
  if (host.length > 255 || /[\s\r\n\\/]/.test(host)) return null

  // Allow IPv6 in brackets: [::1]:3000
  const ipv6 = /^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/
  // Allow hostname / IPv4 with optional port
  const hostPort = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/

  if (!ipv6.test(host) && !hostPort.test(host)) return null
  return host
}

function sanitizeConfiguredAppDomain(appDomain: string): string {
  const url = new URL(appDomain)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid appDomain protocol')
  }

  // Avoid surprising/unsafe URL forms
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''

  return url.toString().replace(/\/$/, '')
}

/**
 * Get the application URL from request headers
 * Priority: DB settings → Request headers (NextRequest or Server Component) → Error
 * Automatically detects headers from Server Components when request is not provided
 */
export async function getAppUrl(request?: NextRequest): Promise<string> {
  // 1. Try database settings first
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { appDomain: true },
    })

    if (settings?.appDomain) {
      try {
        return sanitizeConfiguredAppDomain(settings.appDomain)
      } catch (error) {
        console.error('[URL] Invalid configured appDomain:', error)
        // Continue to request detection
      }
    }
  } catch (error) {
    // DB not available, continue to request detection
  }

  // 2. Extract from request headers if available (API routes)
  if (request) {
    const fallbackProto: 'http' | 'https' = request.url.startsWith('https') ? 'https' : 'http'
    const proto = normalizeProto(request.headers.get('x-forwarded-proto'), fallbackProto)
    const host =
      normalizeHost(request.headers.get('x-forwarded-host')) ||
      normalizeHost(request.headers.get('host'))

    if (host) {
      return `${proto}://${host}`
    }
  }

  // 3. Try to get headers from Server Component context
  try {
    const headersList = await headers()
    const proto = normalizeProto(headersList.get('x-forwarded-proto'), 'http')
    const host =
      normalizeHost(headersList.get('x-forwarded-host')) ||
      normalizeHost(headersList.get('host'))

    if (host) {
      return `${proto}://${host}`
    }
  } catch (error) {
    // Not in a request context
  }

  // 4. No fallback - throw error
  throw new Error('Unable to determine app URL. Please configure domain in Settings or ensure request headers are available.')
}

/**
 * Get the application domain from settings
 * Falls back to empty string if not configured (NO LOCALHOST)
 */
export async function getAppDomain(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { appDomain: true },
    })

    if (settings?.appDomain) {
      return settings.appDomain
    }
  } catch (error) {
    // Silent fail
  }

  // Return empty string - NO LOCALHOST FALLBACK
  return ''
}

/**
 * Generate a share URL for a project
 */
export async function generateShareUrl(
  projectSlug: string,
  request?: NextRequest
): Promise<string> {
  const baseUrl = await getAppUrl(request)
  return `${baseUrl}/share/${projectSlug}`
}
