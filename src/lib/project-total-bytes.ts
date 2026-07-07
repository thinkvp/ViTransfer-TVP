import { prisma } from '@/lib/db'
import { reconcileAllAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { getFilePath } from '@/lib/storage'
import { buildPreviewsRoot } from '@/lib/project-storage-paths'
import { isS3Mode, s3GetFileSize, s3SumPrefixSize } from '@/lib/s3-storage'
import { type FileRole } from '@/lib/stored-file'
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

  // Every project-scoped StoredFile row carries the denormalized projectId, so the
  // whole total is a single aggregate — no need to enumerate videos/assets/albums/
  // photos/comments/files/emails and resolve their child ids.
  const agg = await prismaClient.storedFile.aggregate({
    where: { projectId },
    _sum: { fileSize: true },
  })

  const total = toBigIntSafe(agg._sum.fileSize)
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
 * Recompute and persist previewBytes for a single project (both storage modes).
 * Call this after video processing completes so the dashboard reflects
 * preview storage immediately without waiting for the nightly reconcile.
 */
export async function recalculateAndStoreProjectPreviewBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const previewBytes = await computeProjectPreviewBytes(projectId, prismaClient)
  await prismaClient.project.update({
    where: { id: projectId },
    data: { previewBytes },
  })
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

  // Name-based project tree: originals, assets, photos, comments, emails, ZIPs.
  let total = ZERO
  if (project?.storagePath) {
    total += await computeDirectorySizeBytesBigInt(getFilePath(project.storagePath))
  }

  // ID-keyed previews live OUTSIDE the project tree at previews/{projectId}/… (see
  // project-storage-paths.ts). Include them so diskBytes is the project's TRUE physical
  // footprint — this is what the dashboard "Data" total and project page figures show.
  total += await computeDirectorySizeBytesBigInt(getFilePath(buildPreviewsRoot(projectId)))

  return total > ZERO ? total : ZERO
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
 * Compute the total bytes used by derived video preview files for a project
 * (transcoded previews, thumbnails, timeline VTT + sprite sheets, asset/upload previews).
 *
 * Both modes measure the ID-keyed previews tree (previews/{projectId}/…):
 *  - Local mode walks the directory on disk (sprite sheets have no per-file StoredFile
 *    size, so a registry aggregate would under-count them).
 *  - S3 mode sizes the StoredFile-registered preview objects via the S3 API.
 */
export async function computeProjectPreviewBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma
): Promise<bigint> {
  const ZERO = BigInt(0)
  if (!projectId) return ZERO

  if (!isS3Mode()) {
    // Local mode: previews live under previews/{projectId}/… on disk, OUTSIDE the
    // name-based project tree that computeProjectDiskBytes walks. Sum the whole subtree.
    const previewsRootAbs = getFilePath(buildPreviewsRoot(projectId))
    const bytes = await computeDirectorySizeBytesBigInt(previewsRootAbs)
    return bytes > ZERO ? bytes : ZERO
  }

  // Collect all preview file paths for the project in one query via the denormalized
  // projectId (covers VIDEO, VIDEO_ASSET and SHARE_UPLOAD_FILE preview derivatives).
  const previewRoles: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL',
    'TIMELINE_VTT', 'TIMELINE_SPRITES', 'PREVIEW_IMAGE', 'PREVIEW_MP4', 'HLS_SEGMENTS',
    // Subtitle playback VTT + waveform peaks + cached transcription audio are
    // ID-keyed derived artifacts under the previews tree (local mode counts them
    // via the directory walk above).
    'SUBTITLES_VTT', 'WAVEFORM_PEAKS', 'TRANSCRIPTION_AUDIO']
  // Directory-style roles whose storagePath is a prefix to sum, not a single object.
  // HLS_SEGMENTS covers the whole hls/ tree (variant playlists + init + segments AND the
  // master.m3u8), so HLS_PLAYLIST is deliberately omitted to avoid double-counting it.
  const spriteRoles: FileRole[] = ['TIMELINE_SPRITES', 'HLS_SEGMENTS']

  const rows = await prismaClient.storedFile.findMany({
    where: { projectId, fileRole: { in: previewRoles }, storagePath: { not: '' } },
    select: { storagePath: true, fileRole: true },
  })

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
  const projects = await prismaClient.project.findMany({
    select: { id: true, previewBytes: true },
  })

  let updatedCount = 0
  // Use a concurrency pool to avoid overwhelming S3 (or local disk) with parallel work.
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
