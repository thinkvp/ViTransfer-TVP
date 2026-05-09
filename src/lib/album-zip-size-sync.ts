import { prisma } from '@/lib/db'
import fs from 'fs'
import { getFilePath } from '@/lib/storage'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { isS3Mode, s3GetFileSize } from '@/lib/s3-storage'

async function readFileSizeIfExists(storagePath: string): Promise<bigint> {
  const ZERO = BigInt(0)
  if (isS3Mode()) {
    try {
      const size = await s3GetFileSize(storagePath)
      if (size == null) return ZERO
      return BigInt(Math.max(0, Number(size)))
    } catch {
      return ZERO
    }
  }

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
    select: {
      id: true,
      name: true,
      storageFolderName: true,
      fullZipFileSize: true,
      socialZipFileSize: true,
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
    },
  })
  if (!album) return

  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const albumFolderName = album.storageFolderName || album.name

  const fullZipStoragePath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'full',
  })
  const socialZipStoragePath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'social',
  })

  const [actualFull, actualSocial] = await Promise.all([
    readFileSizeIfExists(fullZipStoragePath),
    readFileSizeIfExists(socialZipStoragePath),
  ])

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
