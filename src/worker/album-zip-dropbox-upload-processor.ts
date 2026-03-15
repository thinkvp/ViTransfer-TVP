import { Job } from 'bullmq'
import { AlbumZipDropboxUploadJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { uploadLocalFileToDropboxPathWithProgress } from '../lib/storage-provider-dropbox'
import { getFilePath } from '../lib/storage'
import { clearResolvedDropboxStorageIssueEntities } from '../lib/dropbox-storage-inconsistency-log'
import fs from 'fs'

const STATUS_FIELD = {
  full: { status: 'fullZipDropboxStatus', progress: 'fullZipDropboxProgress', error: 'fullZipDropboxError' },
  social: { status: 'socialZipDropboxStatus', progress: 'socialZipDropboxProgress', error: 'socialZipDropboxError' },
} as const

/**
 * Background worker that uploads a pre-generated album ZIP file to Dropbox.
 *
 * Triggered after the album-photo-zip worker completes. Tracks upload progress
 * in the Album record so the Running Jobs UI can display real-time status.
 */
export async function processAlbumZipDropboxUpload(job: Job<AlbumZipDropboxUploadJob>) {
  const { albumId, variant, localPath, dropboxPath, fileSizeBytes } = job.data
  const fields = STATUS_FIELD[variant]

  console.log(`[DROPBOX-WORKER] Starting Dropbox upload for album ${albumId} ${variant} ZIP`)
  console.log(`[DROPBOX-WORKER] Local: ${localPath} → Dropbox: ${dropboxPath} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB)`)

  try {
    const album = await prisma.album.findUnique({ where: { id: albumId } })
    if (!album) {
      console.warn(`[DROPBOX-WORKER] Album ${albumId} no longer exists, skipping`)
      return
    }

    await prisma.album.update({
      where: { id: albumId },
      data: {
        [fields.status]: 'UPLOADING',
        [fields.progress]: 0,
        [fields.error]: null,
      },
    })

    const localAbsPath = getFilePath(localPath)
    if (!fs.existsSync(localAbsPath)) {
      throw new Error(`Local ZIP file not found: ${localAbsPath}`)
    }

    let lastProgressUpdate = 0
    const PROGRESS_UPDATE_INTERVAL_MS = 2000

    await uploadLocalFileToDropboxPathWithProgress(localAbsPath, dropboxPath, (uploaded, total) => {
      const now = Date.now()
      if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL_MS) return
      lastProgressUpdate = now

      const progress = Math.min(99, Math.round((uploaded / total) * 100))
      prisma.album.update({
        where: { id: albumId },
        data: { [fields.progress]: progress },
      }).catch(() => {})
    }, dropboxPath) // dropboxPath is already a human-friendly relative path

    await prisma.album.update({
      where: { id: albumId },
      data: {
        [fields.status]: 'COMPLETE',
        [fields.progress]: 100,
        [fields.error]: null,
      },
    })

    await clearResolvedDropboxStorageIssueEntities([
      {
        entityType: 'album-zip',
        entityId: `${albumId}:${variant}`,
        projectId: album.projectId,
      },
    ])

    console.log(`[DROPBOX-WORKER] Upload complete for album ${albumId} ${variant} ZIP`)
  } catch (error: any) {
    console.error(`[DROPBOX-WORKER] Upload failed for album ${albumId} ${variant} ZIP:`, error)

    await prisma.album.update({
      where: { id: albumId },
      data: {
        [fields.status]: 'ERROR',
        [fields.error]: error?.message || 'Unknown error',
      },
    }).catch(() => {})

    throw error // Let BullMQ handle retry
  }
}
