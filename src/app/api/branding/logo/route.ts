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
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
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

async function proxyRemoteLogo(url: string): Promise<NextResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Invalid logo URL protocol' }, { status: 400 })
  }
  if (parsed.username || parsed.password) {
    return NextResponse.json({ error: 'Logo URL must not include credentials' }, { status: 400 })
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    return NextResponse.json({ error: 'Logo URL hostname is not allowed' }, { status: 400 })
  }

  // Best-effort SSRF mitigation: block private IPs from DNS resolution.
  try {
    const addrs = await dns.lookup(parsed.hostname, { all: true, verbatim: true })
    if (addrs.some((a) => isPrivateIp(a.address))) {
      return NextResponse.json({ error: 'Logo URL resolves to a private IP (blocked)' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Failed to resolve logo URL host' }, { status: 400 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some CDNs require a UA.
        'User-Agent': 'ViTransfer/branding-logo',
        'Accept': 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
      },
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch remote logo (${res.status})` }, { status: 502 })
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const allowed = contentType.includes('image/png') || contentType.includes('image/jpeg')
    if (!allowed) {
      return NextResponse.json({ error: 'Remote logo must be a PNG or JPEG image' }, { status: 415 })
    }

    const contentLengthHeader = res.headers.get('content-length')
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN
    if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
      return NextResponse.json({ error: 'Remote logo is too large' }, { status: 413 })
    }

    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > 2_000_000) {
      return NextResponse.json({ error: 'Remote logo is too large' }, { status: 413 })
    }

    return new NextResponse(buf, {
      headers: {
        'Content-Type': contentType.includes('image/png') ? 'image/png' : 'image/jpeg',
        'Content-Length': buf.byteLength.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch remote logo'
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
    'branding-logo'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { companyLogoPath: true, companyLogoMode: true, companyLogoUrl: true },
    })

    const logoPath = settings?.companyLogoPath
    const mode = settings?.companyLogoMode
    const logoUrl = typeof settings?.companyLogoUrl === 'string' ? settings.companyLogoUrl.trim() : ''

    if (!logoPath) {
      if (mode === 'LINK' && logoUrl) {
        return await proxyRemoteLogo(logoUrl)
      }
      return NextResponse.json({ error: 'Logo not configured' }, { status: 404 })
    }

    const fullPath = getFilePath(logoPath)

    const stat = await fs.promises.stat(fullPath).catch(() => null)
    if (!stat || !stat.isFile()) {
      return NextResponse.json({ error: 'Logo not found' }, { status: 404 })
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
        'Content-Type': contentTypeFromPath(logoPath),
        'Content-Length': stat.size.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Error serving company logo:', error)
    return NextResponse.json({ error: 'Failed to load logo' }, { status: 500 })
  }
}
