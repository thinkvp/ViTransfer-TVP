import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getFilePath } from '@/lib/storage'
import fs from 'fs'
import { createReadStream } from 'fs'
import dns from 'dns/promises'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function contentTypeFromPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

function isPrivateIp(ip: string): boolean {
  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7
  if (lower.startsWith('fe80:')) return true // link-local

  // IPv4 and IPv4-mapped
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : ip
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false

  const [a, b] = nums

  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT

  return false
}

async function proxyRemoteFavicon(url: string): Promise<NextResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Invalid favicon URL protocol' }, { status: 400 })
  }
  if (parsed.username || parsed.password) {
    return NextResponse.json({ error: 'Favicon URL must not include credentials' }, { status: 400 })
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    return NextResponse.json({ error: 'Favicon URL hostname is not allowed' }, { status: 400 })
  }

  // Best-effort SSRF mitigation: block private IPs from DNS resolution.
  try {
    const addrs = await dns.lookup(parsed.hostname, { all: true, verbatim: true })
    if (addrs.some((a) => isPrivateIp(a.address))) {
      return NextResponse.json({ error: 'Favicon URL resolves to a private IP (blocked)' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Failed to resolve favicon URL host' }, { status: 400 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'BrandingAssetProxy/favicon',
        'Accept': 'image/png,image/*;q=0.8,*/*;q=0.1',
      },
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch remote favicon (${res.status})` }, { status: 502 })
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('image/png')) {
      return NextResponse.json({ error: 'Remote favicon must be a PNG image' }, { status: 415 })
    }

    const contentLengthHeader = res.headers.get('content-length')
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN
    if (Number.isFinite(contentLength) && contentLength > 512_000) {
      return NextResponse.json({ error: 'Remote favicon is too large' }, { status: 413 })
    }

    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > 512_000) {
      return NextResponse.json({ error: 'Remote favicon is too large' }, { status: 413 })
    }

    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': buf.byteLength.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch remote favicon'
    return NextResponse.json({ error: message }, { status: 502 })
  } finally {
    clearTimeout(timeout)
  }
}

export async function GET(request: NextRequest) {
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    },
    'branding-favicon'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const settings = (await prisma.settings.findUnique({
      where: { id: 'default' },
      // NOTE: keep types happy if Prisma Client isn't regenerated yet.
      select: { companyFaviconPath: true, companyFaviconMode: true, companyFaviconUrl: true } as any,
    } as any)) as any

    const faviconPath = settings?.companyFaviconPath
    const mode = settings?.companyFaviconMode
    const faviconUrl = typeof settings?.companyFaviconUrl === 'string' ? settings.companyFaviconUrl.trim() : ''

    if (!faviconPath) {
      if (mode === 'LINK' && faviconUrl) {
        return await proxyRemoteFavicon(faviconUrl)
      }
      return NextResponse.json({ error: 'Favicon not configured' }, { status: 404 })
    }

    const fullPath = getFilePath(faviconPath)

    const stat = await fs.promises.stat(fullPath).catch(() => null)
    if (!stat || !stat.isFile()) {
      return NextResponse.json({ error: 'Favicon not found' }, { status: 404 })
    }

    const fileStream = createReadStream(fullPath)

    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => controller.enqueue(chunk))
        fileStream.on('end', () => controller.close())
        fileStream.on('error', (err) => controller.error(err))
      },
      cancel() {
        fileStream.destroy()
      },
    })

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': contentTypeFromPath(faviconPath),
        'Content-Length': stat.size.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Error serving company favicon:', error)
    return NextResponse.json({ error: 'Failed to load favicon' }, { status: 500 })
  }
}
