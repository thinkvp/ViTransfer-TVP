import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getAlbumZipFileName } from '@/lib/album-photo-zip'
import type { DownloadableFile, DownloadableGroup, DownloadableFilesResult } from '@/lib/downloadable-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/share/[token]/downloadable-files
// Returns approved video files + assets and album zip files available for download.
// Requires authentication; guest sessions are blocked (403).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-downloadable-files:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const accessCheck = await verifyProjectAccess(
    request,
    projectMeta.id,
    projectMeta.sharePassword,
    projectMeta.authMode
  )

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Block guest sessions — guests cannot download files
  if (accessCheck.isGuest) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()

  // Fetch data in parallel
  const [approvedVideos, albums, approvableCount] = await Promise.all([
    prisma.video.findMany({
      where: {
        projectId: projectMeta.id,
        approved: true,
        status: 'READY',
      },
      include: {
        assets: {
          where: {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
        },
      },
      orderBy: { version: 'desc' },
    }),
    prisma.album.findMany({
      where: { projectId: projectMeta.id, status: 'READY' },
      select: {
        id: true,
        name: true,
        fullZipFileSize: true,
        socialZipFileSize: true,
        socialCopiesEnabled: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.video.count({
      where: { projectId: projectMeta.id, allowApproval: true },
    }),
  ])

  // Build video groups: one per unique video name, taking the highest version (orderBy: version desc)
  const videoNamesSeen = new Set<string>()
  const videoGroups: DownloadableGroup[] = []

  for (const video of approvedVideos) {
    if (videoNamesSeen.has(video.name)) continue
    videoNamesSeen.add(video.name)

    videoGroups.push({
      name: video.name,
      groupType: 'video',
      mainFile: {
        type: 'video',
        videoId: video.id,
        fileName: video.originalFileName,
        fileSizeBytes: Number(video.originalFileSize),
        durationSeconds: Number(video.duration),
      },
      subFiles: video.assets.map((asset): DownloadableFile => ({
        type: 'asset',
        videoId: video.id,
        assetId: asset.id,
        fileName: asset.fileName,
        fileSizeBytes: Number(asset.fileSize),
      })),
    })
  }

  // Sort video groups alphabetically by name
  videoGroups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  // Build album groups: only include albums with at least one ready zip
  const albumGroups: DownloadableGroup[] = []

  for (const album of albums) {
    const zips: DownloadableFile[] = []

    if ((album.fullZipFileSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'full',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'full' }),
        fileSizeBytes: Number(album.fullZipFileSize),
      })
    }

    if (album.socialCopiesEnabled && (album.socialZipFileSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'social',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'social' }),
        fileSizeBytes: Number(album.socialZipFileSize),
      })
    }

    if (zips.length > 0) {
      albumGroups.push({
        name: album.name,
        groupType: 'album',
        subFiles: zips,
      })
    }
  }

  const result: DownloadableFilesResult = {
    groups: [...videoGroups, ...albumGroups],
    hasApprovableVideos: approvableCount > 0,
  }

  return NextResponse.json(result)
}
