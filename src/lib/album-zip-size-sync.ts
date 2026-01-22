import { prisma } from '@/lib/db'
import fs from 'fs'
import { getFilePath } from '@/lib/storage'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'

function readFileSizeIfExists(storagePath: string): bigint {
  const ZERO = BigInt(0)
  try {
    const fullPath = getFilePath(storagePath)
    if (!fs.existsSync(fullPath)) return ZERO
    const st = fs.statSync(fullPath)
    return BigInt(st.size)
  } catch {
    return ZERO
  }
}

export async function syncAlbumZipSizes(params: { albumId: string; projectId: string }): Promise<void> {
  const { albumId, projectId } = params
  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { id: true, fullZipFileSize: true, socialZipFileSize: true },
  })
  if (!album) return

  const fullZipStoragePath = getAlbumZipStoragePath({ projectId, albumId, variant: 'full' })
  const socialZipStoragePath = getAlbumZipStoragePath({ projectId, albumId, variant: 'social' })

  const actualFull = readFileSizeIfExists(fullZipStoragePath)
  const actualSocial = readFileSizeIfExists(socialZipStoragePath)

  const deltaFull = actualFull - album.fullZipFileSize
  const deltaSocial = actualSocial - album.socialZipFileSize

  if (deltaFull === BigInt(0) && deltaSocial === BigInt(0)) return

  await prisma.album.update({
    where: { id: albumId },
    data: {
      fullZipFileSize: actualFull,
      socialZipFileSize: actualSocial,
    },
  })

  await adjustProjectTotalBytes(projectId, deltaFull + deltaSocial)
}
