import { prisma } from '@/lib/db'
import { getFilePath } from '@/lib/storage'
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

  const [videoIds, albumIds, projectEmailIds] = await Promise.all([
    prismaClient.video.findMany({
      where: { projectId },
      select: { id: true },
    }),
    prismaClient.album.findMany({
      where: { projectId },
      select: { id: true },
    }),
    prismaClient.projectEmail.findMany({
      where: { projectId },
      select: { id: true },
    }),
  ])

  const videoIdList = videoIds.map((v) => v.id)
  const albumIdList = albumIds.map((a) => a.id)
  const projectEmailIdList = projectEmailIds.map((e) => e.id)

  const [
    videoRow,
    projectEmailRow,
    commentFileRow,
    projectFileRow,
    assetRows,
    albumRow,
    albumPhotoRows,
    projectEmailAttachmentRows,
  ] = await Promise.all([
    prismaClient.video.aggregate({
      where: { projectId },
      _sum: { originalFileSize: true },
    }),
    prismaClient.projectEmail.aggregate({
      where: { projectId },
      _sum: { rawFileSize: true },
    }),
    prismaClient.commentFile.aggregate({
      where: { projectId },
      _sum: { fileSize: true },
    }),
    prismaClient.projectFile.aggregate({
      where: { projectId },
      _sum: { fileSize: true },
    }),
    videoIdList.length > 0
      ? prismaClient.videoAsset.aggregate({
          where: { videoId: { in: videoIdList } },
          _sum: { fileSize: true },
        })
      : Promise.resolve({ _sum: { fileSize: ZERO as any } } as any),
    prismaClient.album.aggregate({
      where: { projectId },
      _sum: { fullZipFileSize: true, socialZipFileSize: true },
    }),
    albumIdList.length > 0
      ? prismaClient.albumPhoto.aggregate({
          where: { albumId: { in: albumIdList } },
          _sum: { fileSize: true, socialFileSize: true },
        })
      : Promise.resolve({ _sum: { fileSize: ZERO as any, socialFileSize: ZERO as any } } as any),
    projectEmailIdList.length > 0
      ? prismaClient.projectEmailAttachment.aggregate({
          where: { projectEmailId: { in: projectEmailIdList } },
          _sum: { fileSize: true },
        })
      : Promise.resolve({ _sum: { fileSize: ZERO as any } } as any),
  ])

  const total =
    toBigIntSafe((videoRow as any)?._sum?.originalFileSize) +
    toBigIntSafe((projectEmailRow as any)?._sum?.rawFileSize) +
    toBigIntSafe((commentFileRow as any)?._sum?.fileSize) +
    toBigIntSafe((projectFileRow as any)?._sum?.fileSize) +
    toBigIntSafe((assetRows as any)?._sum?.fileSize) +
    toBigIntSafe((albumRow as any)?._sum?.fullZipFileSize) +
    toBigIntSafe((albumRow as any)?._sum?.socialZipFileSize) +
    toBigIntSafe((albumPhotoRows as any)?._sum?.fileSize) +
    toBigIntSafe((albumPhotoRows as any)?._sum?.socialFileSize) +
    toBigIntSafe((projectEmailAttachmentRows as any)?._sum?.fileSize)

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

  const projectRootAbs = getFilePath(`projects/${projectId}`)
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

export async function reconcileAllProjectsStorageTotals(
  prismaClient: typeof prisma = prisma
): Promise<{
  totalBytes: { checkedCount: number; updatedCount: number }
  diskBytes: { checkedCount: number; updatedCount: number }
}> {
  const [totalBytes, diskBytes] = await Promise.all([
    reconcileAllProjectsTotalBytes(prismaClient),
    reconcileAllProjectsDiskBytes(prismaClient),
  ])

  return { totalBytes, diskBytes }
}
