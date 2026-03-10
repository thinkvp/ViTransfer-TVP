import { NextResponse, NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { parseResolutions } from '@/worker/video-processor-helpers'
export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/default-quality
 * 
 * Public endpoint - Returns default preview resolution settings
 * This is used by public share pages to determine initial video quality
 * 
 * SECURITY NOTE: This is intentionally public as it only exposes
 * a non-sensitive preference setting. No private data is exposed.
 */
export async function GET(request: NextRequest) {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { 
        defaultPreviewResolutions: true 
      },
    })

    const resolutions = parseResolutions(settings?.defaultPreviewResolutions)

    return NextResponse.json({
      defaultPreviewResolution: resolutions[0] || '720p',
      defaultPreviewResolutions: resolutions,
    })
  } catch (error) {
    console.error('Error fetching default quality:', error)
    return NextResponse.json(
      { defaultPreviewResolution: '720p', defaultPreviewResolutions: ['720p'] },
      { status: 200 }
    )
  }
}
