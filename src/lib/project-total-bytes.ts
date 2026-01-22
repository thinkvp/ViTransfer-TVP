import { prisma } from '@/lib/db'

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
