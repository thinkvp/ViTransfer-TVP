import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { albumZipExists, getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/albums/[albumId]/zip-status (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'album-zip-status'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { id: true, projectId: true },
  })

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  const uploadingCount = await prisma.albumPhoto.count({ where: { albumId, status: 'UPLOADING' } })
  const readyCount = await prisma.albumPhoto.count({ where: { albumId, status: 'READY' } })

  const socialReadyCount = await prisma.albumPhoto.count({
    where: { albumId, status: 'READY', socialStatus: 'READY' },
  })
  const socialPendingCount = await prisma.albumPhoto.count({
    where: { albumId, status: 'READY', socialStatus: { in: ['PENDING', 'PROCESSING'] } },
  })
  const socialErrorCount = await prisma.albumPhoto.count({
    where: { albumId, status: 'READY', socialStatus: 'ERROR' },
  })

  const fullZipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'full' })
  const socialZipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'social' })

  return NextResponse.json({
    zip: {
      fullReady: albumZipExists(fullZipStoragePath),
      socialReady: albumZipExists(socialZipStoragePath),
    },
    counts: {
      uploading: uploadingCount,
      ready: readyCount,
      socialReady: socialReadyCount,
      socialPending: socialPendingCount,
      socialError: socialErrorCount,
    },
  })
}
