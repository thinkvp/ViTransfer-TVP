import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile } from '@/lib/storage'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/albums/[albumId]/zip-regenerate (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'album-zip-regenerate'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { id: true, projectId: true },
  })

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  const fullZipPath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'full' })
  const socialZipPath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'social' })

  await deleteFile(fullZipPath).catch(() => {})
  await deleteFile(socialZipPath).catch(() => {})

  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const q = getAlbumPhotoZipQueue()

    const fullJobId = getAlbumZipJobId({ albumId: album.id, variant: 'full' })
    const socialJobId = getAlbumZipJobId({ albumId: album.id, variant: 'social' })

    await q.remove(fullJobId).catch(() => {})
    await q.remove(socialJobId).catch(() => {})

    await q.add('generate-album-zip', { albumId: album.id, variant: 'full' }, { jobId: fullJobId }).catch(() => {})
    await q.add('generate-album-zip', { albumId: album.id, variant: 'social' }, { jobId: socialJobId }).catch(() => {})
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true })
}
