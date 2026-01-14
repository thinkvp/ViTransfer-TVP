import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSecuritySettings } from '@/lib/video-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ONE_BY_ONE_GIF_BASE64 =
  'R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='

function gifResponse() {
  return new NextResponse(Buffer.from(ONE_BY_ONE_GIF_BASE64, 'base64'), {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
      expires: '0',
    },
  })
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params

  // Always return a pixel, even if tracking is disabled.
  try {
    const security = await getSecuritySettings()
    if (!security.trackAnalytics) return gifResponse()

    await prisma.salesEmailTracking.updateMany({
      where: {
        token,
        openedAt: null,
      },
      data: {
        openedAt: new Date(),
      },
    })
  } catch {
    // Best-effort; never break email rendering.
  }

  return gifResponse()
}
