import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Transparent 1x1 pixel GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

// GET /api/track/email/[token] - Track email opens via pixel
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    // Find tracking record
    const tracking = await prisma.emailTracking.findUnique({
      where: { token },
    })

    if (tracking) {
      // Only record first open (prevent multiple opens from incrementing)
      if (!tracking.openedAt) {
        await prisma.emailTracking.update({
          where: { token },
          data: { openedAt: new Date() },
        })
      }
    }

    // Always return pixel (even if token not found, to avoid revealing valid tokens)
    return new NextResponse(PIXEL, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    // Return pixel even on error (silent failure)
    return new NextResponse(PIXEL, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  }
}
