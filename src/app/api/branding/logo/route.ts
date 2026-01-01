import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getFilePath } from '@/lib/storage'
import fs from 'fs'
import { createReadStream } from 'fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function contentTypeFromPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
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
      select: { companyLogoPath: true },
    })

    const logoPath = settings?.companyLogoPath
    if (!logoPath) {
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
