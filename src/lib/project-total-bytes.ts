import { prisma } from '@/lib/db'
import { reconcileAllAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { getFilePath } from '@/lib/storage'
import { isS3Mode, s3GetFileSize, s3SumPrefixSize } from '@/lib/s3-storage'
import { buildProjectStorageRoot, buildVideoAssetPreviewStoragePath } from '@/lib/project-storage-paths'
import { getStoredPathsForEntities, type FileRole } from '@/lib/stored-file'
import * as fs from 'fs'
import * as path from 'path'

async function computeDirectorySizeBytesBigInt(absolutePath: string): Promise<bigint> {
  try {
    const rootStat = await fs.promises.lstat(absolutePath)
    if (rootStat.isFile()) return BigInt(rootStat.size)
    if (!rootStat.isDirectory()) return BigInt(0)
  } catch {
    return BigInt(0)
  }

  let total = BigInt(0)
  const stack: string[] = [absolutePath]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }

      if (entry.isFile()) {
        try {
          const st = await fs.promises.lstat(full)
          total += BigInt(st.size)
        } catch {
          // ignore
        }
      }
    }
  }

  return total
}

async function asyncPool<T, R>(limit: number, items: T[], iterator: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      const i = nextIndex
      nextIndex++
      if (i >= items.length) return
      results[i] = await iterator(items[i])
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

export async function adjustProjectTotalBytes(
  projectId: string,
  deltaBytes: bigint,
  prismaClient: typeof prisma = prisma
): Promise<void> {
  const ZERO = BigInt(0)
  if (!projectId) return
  if (deltaBytes === ZERO) return

  if (deltaBytes > ZERO) {
    await prismaClient.project.update({
      where: { id: projectId },
      data: { totalBytes: { increment: deltaBytes } },
    })
    return
  }

  await prismaClient.project.update({
    where: { id: projectId },
    data: { totalBytes: { decrement: deltaBytes * BigInt(-1) } },
  })
}

function toBigIntSafe(v: unknown): bigint {
  const ZERO = BigInt(0)
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ZERO
    if (v <= 0) return ZERO
    return BigInt(Math.floor(v))
  }
  if (typeof v === 'string') {
    try {
      const n = BigInt(v)
      return n > ZERO ? n : ZERO
    } catch {
      return ZERO
    }
  }
  return ZERO
}

export async function computeProjectTotalBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const ZERO = BigInt(0)
  if (!projectId) return ZERO

  // Resolve entity IDs first
  const videoIds = await prismaClient.video.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(v => v.id))
  const albumIds = await prismaClient.album.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(a => a.id))
  const projectEmailIds = await prismaClient.projectEmail.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(e => e.id))
  const projectFileIds = await prismaClient.projectFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id))
  const commentFileIds = await prismaClient.commentFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id))
  const shareUploadFileIds = await prismaClient.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id))

  // Resolve asset and photo IDs through parent entities
  const assetIds = videoIds.length > 0
    ? await prismaClient.videoAsset.findMany({ where: { videoId: { in: videoIds } }, select: { id: true } }).then(r => r.map(a => a.id))
    : [] as string[]
  const photoIds = albumIds.length > 0
    ? await prismaClient.albumPhoto.findMany({ where: { albumId: { in: albumIds } }, select: { id: true } }).then(r => r.map(p => p.id))
    : [] as string[]
  const emailAttachmentIds = projectEmailIds.length > 0
    ? await prismaClient.projectEmailAttachment.findMany({ where: { projectEmailId: { in: projectEmailIds } }, select: { id: true } }).then(r => r.map(a => a.id))
    : [] as string[]

  // Aggregate all file sizes through StoredFile — single source of truth
  const orClauses: any[] = [
    videoIds.length > 0 && { entityType: 'VIDEO', entityId: { in: videoIds } },
    assetIds.length > 0 && { entityType: 'VIDEO_ASSET', entityId: { in: assetIds } },
    shareUploadFileIds.length > 0 && { entityType: 'SHARE_UPLOAD_FILE', entityId: { in: shareUploadFileIds } },
    albumIds.length > 0 && { entityType: 'ALBUM', entityId: { in: albumIds } },
    photoIds.length > 0 && { entityType: 'ALBUM_PHOTO', entityId: { in: photoIds } },
    projectFileIds.length > 0 && { entityType: 'PROJECT_FILE', entityId: { in: projectFileIds } },
    commentFileIds.length > 0 && { entityType: 'COMMENT_FILE', entityId: { in: commentFileIds } },
    projectEmailIds.length > 0 && { entityType: 'PROJECT_EMAIL', entityId: { in: projectEmailIds } },
    emailAttachmentIds.length > 0 && { entityType: 'PROJECT_EMAIL_ATTACHMENT', entityId: { in: emailAttachmentIds } },
  ].filter(Boolean)

  const groupRows = await prismaClient.storedFile.groupBy({
    by: ['entityType'],
    where: { OR: orClauses },
    _sum: { fileSize: true },
  })

  let total = ZERO
  for (const row of groupRows) {
    total += toBigIntSafe(row._sum.fileSize)
  }

  return total > ZERO ? total : ZERO
}

export async function recalculateAndStoreProjectTotalBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const totalBytes = await computeProjectTotalBytes(projectId, prismaClient)
  await prismaClient.project.update({
    where: { id: projectId },
    data: { totalBytes },
  })
  return totalBytes
}

/**
 * Recompute and persist previewBytes for a single project.
 * No-ops in local/disk mode (previewBytes stays 0).
 * Call this after video processing completes so the dashboard reflects
 * preview storage immediately without waiting for the nightly reconcile.
 */
export async function recalculateAndStoreProjectPreviewBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const previewBytes = await computeProjectPreviewBytes(projectId, prismaClient)
  if (isS3Mode()) {
    await prismaClient.project.update({
      where: { id: projectId },
      data: { previewBytes },
    })
  }
  return previewBytes
}

export async function reconcileAllProjectsTotalBytes(
  prismaClient: typeof prisma = prisma
): Promise<{ checkedCount: number; updatedCount: number }> {
  const projects = await prismaClient.project.findMany({
    select: { id: true, totalBytes: true },
  })

  let updatedCount = 0
  for (const p of projects) {
    const computed = await computeProjectTotalBytes(p.id, prismaClient)
    const stored = toBigIntSafe((p as any).totalBytes)
    if (computed !== stored) {
      await prismaClient.project.update({
        where: { id: p.id },
        data: { totalBytes: computed },
      })
      updatedCount++
    }
  }

  return { checkedCount: projects.length, updatedCount }
}

export async function computeProjectDiskBytes(
  projectId: string
): Promise<bigint> {
  const ZERO = BigInt(0)
  if (!projectId) return ZERO

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { storagePath: true },
  })

  if (!project?.storagePath) return ZERO

  const projectRootAbs = getFilePath(project.storagePath)
  const bytes = await computeDirectorySizeBytesBigInt(projectRootAbs)
  return bytes > ZERO ? bytes : ZERO
}

export async function recalculateAndStoreProjectDiskBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const diskBytes = await computeProjectDiskBytes(projectId)
  await prismaClient.project.update({
    where: { id: projectId },
    data: { diskBytes },
  })
  return diskBytes
}

export async function reconcileAllProjectsDiskBytes(
  prismaClient: typeof prisma = prisma,
  opts?: { concurrency?: number }
): Promise<{ checkedCount: number; updatedCount: number }> {
  const projects = await prismaClient.project.findMany({
    select: { id: true, diskBytes: true },
  })

  let updatedCount = 0
  const concurrency = Math.max(1, Math.min(6, opts?.concurrency ?? 2))

  await asyncPool(concurrency, projects, async (p) => {
    const computed = await computeProjectDiskBytes(p.id)
    const stored = toBigIntSafe((p as any).diskBytes)
    if (computed !== stored) {
      await prismaClient.project.update({
        where: { id: p.id },
        data: { diskBytes: computed },
      })
      updatedCount++
    }
  })

  return { checkedCount: projects.length, updatedCount }
}

/**
 * Compute the total bytes used by S3-stored video preview files for a project.
 * Uses StoredFile registry as the single source of truth for preview file paths.
 * Returns 0 in local/disk storage mode.
 */
export async function computeProjectPreviewBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const ZERO = BigInt(0)
  if (!projectId || !isS3Mode()) return ZERO

  // Resolve entity IDs
  const videoIds = await prismaClient.video.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(v => v.id))
  const assetIds = videoIds.length > 0
    ? await prismaClient.videoAsset.findMany({ where: { videoId: { in: videoIds } }, select: { id: true } }).then(r => r.map(a => a.id))
    : [] as string[]
  const uploadIds = await prismaClient.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id))

  // Collect all preview file paths from StoredFile
  const previewRoles: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL',
    'TIMELINE_VTT', 'TIMELINE_SPRITES', 'PREVIEW_IMAGE', 'PREVIEW_MP4']
  const spriteRoles: FileRole[] = ['TIMELINE_SPRITES']

  const rows: Array<{ storagePath: string; fileRole: string }> = []
  const baseWhere = { storagePath: { not: '' } } as const
  if (videoIds.length > 0) {
    const paths = await prisma.storedFile.findMany({ where: { entityType: 'VIDEO', entityId: { in: videoIds }, fileRole: { in: previewRoles }, ...baseWhere }, select: { storagePath: true, fileRole: true } })
    rows.push(...paths.map(r => ({ storagePath: r.storagePath, fileRole: r.fileRole })))
  }
  if (assetIds.length > 0) {
    const paths = await prisma.storedFile.findMany({ where: { entityType: 'VIDEO_ASSET', entityId: { in: assetIds }, fileRole: { in: previewRoles }, ...baseWhere }, select: { storagePath: true, fileRole: true } })
    rows.push(...paths.map(r => ({ storagePath: r.storagePath, fileRole: r.fileRole })))
  }
  if (uploadIds.length > 0) {
    const paths = await prisma.storedFile.findMany({ where: { entityType: 'SHARE_UPLOAD_FILE', entityId: { in: uploadIds }, fileRole: { in: previewRoles }, ...baseWhere }, select: { storagePath: true, fileRole: true } })
    rows.push(...paths.map(r => ({ storagePath: r.storagePath, fileRole: r.fileRole })))
  }

  if (rows.length === 0) return ZERO

  const previewFilePaths = new Set<string>()
  const spritePrefixes = new Set<string>()

  for (const row of rows) {
    if (spriteRoles.includes(row.fileRole as any)) {
      spritePrefixes.add(row.storagePath)
    } else {
      previewFilePaths.add(row.storagePath)
    }
  }

  const [fileSizes, prefixSizes] = await Promise.all([
    Promise.all([...previewFilePaths].map((p) => s3GetFileSize(p))),
    Promise.all([...spritePrefixes].map((p) => s3SumPrefixSize(p))),
  ])

  const total =
    fileSizes.reduce<number>((sum, size) => sum + Math.max(0, Number(size || 0)), 0) +
    prefixSizes.reduce<number>((sum, size) => sum + Math.max(0, Number(size || 0)), 0)

  return total > 0 ? BigInt(Math.round(total)) : ZERO
}

export async function reconcileAllProjectsPreviewBytes(
  prismaClient: typeof prisma = prisma
): Promise<{ checkedCount: number; updatedCount: number }> {
  // Only meaningful in S3 mode; in local mode keep previewBytes = 0.
  if (!isS3Mode()) {
    return { checkedCount: 0, updatedCount: 0 }
  }

  const projects = await prismaClient.project.findMany({
    select: { id: true, previewBytes: true },
  })

  let updatedCount = 0
  // Use a concurrency pool to avoid overwhelming S3 with parallel requests.
  await asyncPool(2, projects, async (p) => {
    const computed = await computeProjectPreviewBytes(p.id, prismaClient)
    const stored = toBigIntSafe((p as any).previewBytes)
    if (computed !== stored) {
      await prismaClient.project.update({
        where: { id: p.id },
        data: { previewBytes: computed },
      })
      updatedCount++
    }
  })

  return { checkedCount: projects.length, updatedCount }
}

export async function reconcileAllProjectsStorageTotals(
  prismaClient: typeof prisma = prisma
): Promise<{
  totalBytes: { checkedCount: number; updatedCount: number }
  diskBytes: { checkedCount: number; updatedCount: number }
  previewBytes: { checkedCount: number; updatedCount: number }
}> {
  await reconcileAllAlbumZipSizes(prismaClient)

  const [totalBytes, diskBytes, previewBytes] = await Promise.all([
    reconcileAllProjectsTotalBytes(prismaClient),
    reconcileAllProjectsDiskBytes(prismaClient),
    reconcileAllProjectsPreviewBytes(prismaClient),
  ])

  return { totalBytes, diskBytes, previewBytes }
}
