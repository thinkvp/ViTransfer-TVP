import { prisma } from '@/lib/db'
import fs from 'fs'
import { getFilePath } from '@/lib/storage'
import { getAlbumZipStoragePaths } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { registerStoredFile } from '@/lib/stored-file'
import { isS3Mode, s3GetFileSize } from '@/lib/s3-storage'

type AlbumZipAlbumRow = {
  id: string
  projectId: string
  name: string
  storageFolderName: string | null
  project: {
    storagePath: string | null
    title: string
    companyName: string | null
    client: { name: string } | null
  }
}

async function asyncPool<T>(limit: number, items: T[], iterator: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex++
      if (index >= items.length) return
      await iterator(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker()))
}

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

function getAlbumZipPaths(album: AlbumZipAlbumRow): { full: string; social: string } {
  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const albumFolderName = album.storageFolderName || album.name

  return getAlbumZipStoragePaths({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
  })
}

async function resolveAlbumZipSizes(album: AlbumZipAlbumRow): Promise<{ actualFull: bigint; actualSocial: bigint }> {
  const zipPaths = getAlbumZipPaths(album)
  const [actualFull, actualSocial] = await Promise.all([
    readFileSizeIfExists(zipPaths.full),
    readFileSizeIfExists(zipPaths.social),
  ])

  return { actualFull, actualSocial }
}

export async function syncAlbumZipSizes(params: { albumId: string; projectId: string }): Promise<void> {
  const { albumId, projectId } = params
  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      project: {
        select: { title: true,
          companyName: true,
          storagePath: true,
          client: { select: { name: true } },
        },
      },
    },
  })
  if (!album) return

  const { actualFull, actualSocial } = await resolveAlbumZipSizes(album)

  // Read previous ZIP sizes from StoredFile registry
  const [prevFull, prevSocial] = await Promise.all([
    prisma.storedFile.findUnique({ where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: albumId, fileRole: 'ZIP_FULL' } }, select: { fileSize: true } }),
    prisma.storedFile.findUnique({ where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: albumId, fileRole: 'ZIP_SOCIAL' } }, select: { fileSize: true } }),
  ])
  const prevFullSize = prevFull?.fileSize ?? BigInt(0)
  const prevSocialSize = prevSocial?.fileSize ?? BigInt(0)

  const deltaFull = actualFull - prevFullSize
  const deltaSocial = actualSocial - prevSocialSize

  if (deltaFull === BigInt(0) && deltaSocial === BigInt(0)) return

  // Update StoredFile through the registry helper so projectId is populated (legacy Album
  // columns dropped). projectId is passed explicitly to skip the resolve lookup.
  await Promise.all([
    registerStoredFile({ entityType: 'ALBUM', entityId: albumId, fileRole: 'ZIP_FULL', projectId,
      storagePath: getAlbumZipPaths(album).full, fileSize: actualFull, status: 'READY' }),
    registerStoredFile({ entityType: 'ALBUM', entityId: albumId, fileRole: 'ZIP_SOCIAL', projectId,
      storagePath: getAlbumZipPaths(album).social, fileSize: actualSocial, status: 'READY' }),
  ])

  await adjustProjectTotalBytes(projectId, deltaFull + deltaSocial)
}

export async function reconcileAllAlbumZipSizes(
  prismaClient: typeof prisma = prisma,
): Promise<{ checkedCount: number; updatedCount: number }> {
  const albums = await prismaClient.album.findMany({
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      project: {
        select: { title: true,
          companyName: true,
          storagePath: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  let updatedCount = 0
  await asyncPool(4, albums, async (album) => {
    const { actualFull, actualSocial } = await resolveAlbumZipSizes(album)

    const [prevFull, prevSocial] = await Promise.all([
      prismaClient.storedFile.findUnique({ where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_FULL' } }, select: { fileSize: true } }),
      prismaClient.storedFile.findUnique({ where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_SOCIAL' } }, select: { fileSize: true } }),
    ])
    if ((prevFull?.fileSize ?? BigInt(0)) === actualFull && (prevSocial?.fileSize ?? BigInt(0)) === actualSocial) {
      return
    }

    const zipPaths = getAlbumZipPaths(album)
    await Promise.all([
      prismaClient.storedFile.upsert({
        where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_FULL' } },
        create: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_FULL', projectId: album.projectId, storagePath: zipPaths.full, fileSize: actualFull, status: 'READY' },
        update: { fileSize: actualFull },
      }),
      prismaClient.storedFile.upsert({
        where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_SOCIAL' } },
        create: { entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_SOCIAL', projectId: album.projectId, storagePath: zipPaths.social, fileSize: actualSocial, status: 'READY' },
        update: { fileSize: actualSocial },
      }),
    ])
    updatedCount++
  })

  return { checkedCount: albums.length, updatedCount }
}
