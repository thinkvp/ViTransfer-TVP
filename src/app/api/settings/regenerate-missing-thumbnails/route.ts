import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getVideoQueue } from '@/lib/queue'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { resolveVideoOriginalPath, storagePathExistsLocal } from '@/lib/resolve-video-original'

export const runtime = 'nodejs'

type MissingThumbnailRepairResult = {
  ok: true
  dryRun: boolean
  videosChecked: number
  videosEligible: number
  queued?: number
  skippedClosedProjects: number
  skippedCustomThumbnails: number
  skippedMissingOriginals: number
  sample?: Array<{ videoId: string; projectId: string; projectTitle: string; videoName: string; versionLabel: string; reason: string }>
}

function storagePathExists(storagePath: string | null | undefined): boolean {
  return storagePathExistsLocal(storagePath)
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many thumbnail repair requests. Please slow down.' },
    'regenerate-missing-thumbnails'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
  } catch {
    // ignore
  }

  const videos = await prisma.video.findMany({
    where: {
      status: { in: ['READY', 'ERROR'] },
    },
    select: {
      id: true,
      name: true,
      versionLabel: true,
      originalFileName: true,
      originalStoragePath: true,
      thumbnailPath: true,
      storageFolderName: true,
      projectId: true,
      project: {
        select: {
          title: true,
          status: true,
          storagePath: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
      assets: {
        select: { storagePath: true },
      },
    },
    orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
  })

  let skippedClosedProjects = 0
  let skippedCustomThumbnails = 0
  let skippedMissingOriginals = 0
  const eligible = [] as typeof videos
  const sample: MissingThumbnailRepairResult['sample'] = []

  for (const video of videos) {
    if (video.project.status === 'CLOSED') {
      skippedClosedProjects += 1
      continue
    }

    const hasCustomThumbnail = video.thumbnailPath
      ? video.assets.some((asset) => asset.storagePath === video.thumbnailPath) || video.thumbnailPath.includes('/videos/assets/')
      : false

    if (hasCustomThumbnail) {
      skippedCustomThumbnails += 1
      continue
    }

    const resolvedOriginalPath = resolveVideoOriginalPath(video)
    if (!resolvedOriginalPath) {
      skippedMissingOriginals += 1
      if (sample.length < 20) {
        sample.push({
          videoId: video.id,
          projectId: video.projectId,
          projectTitle: video.project.title,
          videoName: video.name,
          versionLabel: video.versionLabel,
          reason: 'original file missing on disk',
        })
      }
      continue
    }

    const missingThumbnail = !video.thumbnailPath || !storagePathExists(video.thumbnailPath)
    if (!missingThumbnail) continue

    eligible.push({ ...video, originalStoragePath: resolvedOriginalPath })
    if (sample.length < 20) {
      sample.push({
        videoId: video.id,
        projectId: video.projectId,
        projectTitle: video.project.title,
        videoName: video.name,
        versionLabel: video.versionLabel,
        reason: video.thumbnailPath ? 'thumbnail file missing on disk' : 'thumbnailPath is null',
      })
    }
  }

  let queued = 0

  if (!dryRun && eligible.length > 0) {
    const videoQueue = getVideoQueue()
    for (const video of eligible) {
      await prisma.video.update({
        where: { id: video.id },
        data: {
          status: 'QUEUED',
          processingProgress: 0,
          processingPhase: null,
          thumbnailPath: null,
        },
      })

      await videoQueue.add('process-video', {
        videoId: video.id,
        originalStoragePath: video.originalStoragePath,
        projectId: video.projectId,
        thumbnailOnly: true,
        regenerateThumbnail: true,
        regenerateTimelinePreviews: false,
      })

      queued += 1
    }
  }

  const result: MissingThumbnailRepairResult = {
    ok: true,
    dryRun,
    videosChecked: videos.length,
    videosEligible: eligible.length,
    ...(dryRun ? {} : { queued }),
    skippedClosedProjects,
    skippedCustomThumbnails,
    skippedMissingOriginals,
    sample,
  }

  return NextResponse.json(result)
}