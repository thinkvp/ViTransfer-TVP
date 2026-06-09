import { prisma } from '@/lib/db'

const BYTES_PER_MB = BigInt(1024 * 1024)

export interface ProjectUploadUsage {
  commentBytes: bigint
  uploadsBytes: bigint
  totalBytes: bigint
}

export interface ProjectUploadQuotaResult {
  allowed: boolean
  totalUsedBytes: bigint
  limitBytes: bigint
  remainingBytes: bigint
}

export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (value < BigInt(0)) return 0
  return Number(value)
}

export async function getProjectUploadUsageBytes(
  projectId: string,
  prismaClient: typeof prisma = prisma,
): Promise<ProjectUploadUsage> {
  // Resolve file IDs for this project (entityId in StoredFile is the file's own ID)
  const [commentFileIds, uploadFileIds] = await Promise.all([
    prismaClient.commentFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id)),
    prismaClient.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id)),
  ])

  const [commentAggregate, uploadsAggregate] = await Promise.all([
    commentFileIds.length > 0 ? prismaClient.storedFile.aggregate({
      where: { entityType: 'COMMENT_FILE', entityId: { in: commentFileIds }, fileRole: 'ORIGINAL' },
      _sum: { fileSize: true },
    }) : { _sum: { fileSize: BigInt(0) } },
    uploadFileIds.length > 0 ? prismaClient.storedFile.aggregate({
      where: { entityType: 'SHARE_UPLOAD_FILE', entityId: { in: uploadFileIds }, fileRole: 'ORIGINAL' },
      _sum: { fileSize: true },
    }) : { _sum: { fileSize: BigInt(0) } },
  ])

  const commentBytes = (commentAggregate._sum.fileSize ?? BigInt(0)) as bigint
  const uploadsBytes = (uploadsAggregate._sum.fileSize ?? BigInt(0)) as bigint
  const totalBytes = commentBytes + uploadsBytes

  return {
    commentBytes,
    uploadsBytes,
    totalBytes,
  }
}

export async function checkProjectUploadQuota(
  projectId: string,
  limitMB: number,
  incomingBytes: bigint,
  prismaClient: typeof prisma = prisma,
): Promise<ProjectUploadQuotaResult> {
  const { totalBytes } = await getProjectUploadUsageBytes(projectId, prismaClient)

  if (limitMB <= 0) {
    return {
      allowed: true,
      totalUsedBytes: totalBytes,
      limitBytes: BigInt(0),
      remainingBytes: BigInt(0),
    }
  }

  const limitBytes = BigInt(limitMB) * BYTES_PER_MB
  const remainingBytes = totalBytes >= limitBytes ? BigInt(0) : (limitBytes - totalBytes)
  const allowed = totalBytes + incomingBytes <= limitBytes

  return {
    allowed,
    totalUsedBytes: totalBytes,
    limitBytes,
    remainingBytes,
  }
}
