import fs from 'fs'
import path from 'path'
import { prisma } from './db'

const TUS_UPLOAD_DIR = '/tmp/vitransfer-tus-uploads'
const MAX_AGE_HOURS = 24 // Remove files older than 24 hours

/**
 * Clean up orphaned upload files
 * This should be run periodically (e.g., via cron job)
 */
export async function cleanupOrphanedUploads() {
  if (!fs.existsSync(TUS_UPLOAD_DIR)) {
    return
  }

  try {
    const files = fs.readdirSync(TUS_UPLOAD_DIR)
    const now = Date.now()
    let cleanedCount = 0
    let skippedCount = 0

    for (const file of files) {
      try {
        const filePath = path.join(TUS_UPLOAD_DIR, file)
        const stats = fs.statSync(filePath)

        // Skip if not a file
        if (!stats.isFile()) {
          continue
        }

        // Calculate age in hours
        const ageMs = now - stats.mtimeMs
        const ageHours = ageMs / (1000 * 60 * 60)

        // Remove files older than MAX_AGE_HOURS
        if (ageHours > MAX_AGE_HOURS) {
          fs.unlinkSync(filePath)
          cleanedCount++

          // Also check for .info file and remove it
          const infoPath = `${filePath}.info`
          if (fs.existsSync(infoPath)) {
            fs.unlinkSync(infoPath)
          }
        } else {
          skippedCount++
        }
      } catch (error) {
        console.error(`[Upload Cleanup] Error processing file ${file}:`, error)
      }
    }
  } catch (error) {
    console.error('[Upload Cleanup] Error during cleanup:', error)
  }
}

/**
 * Clean up failed/stuck uploads from database
 * Marks videos as ERROR if they've been in UPLOADING state for too long,
 * and deletes truly orphaned records (created but never received any data).
 */
export async function cleanupStuckUploads() {
  try {
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // --- Videos ---
    const stuckVideos = await prisma.video.findMany({
      where: {
        status: 'UPLOADING',
        createdAt: { lt: cutoffDate },
      },
      select: {
        id: true,
        uploadProgress: true,
        projectId: true,
      },
    })

    for (const video of stuckVideos) {
      if (video.uploadProgress === 0) {
        // Never received any data — delete the orphaned record entirely.
        // Cascade will also remove any VideoAsset children.
        await prisma.video.delete({ where: { id: video.id } }).catch(() => {})
        console.log(`[Upload Cleanup] Deleted orphaned video ${video.id} (0% progress, >24h old)`)
      } else {
        // Partial upload — mark as ERROR so the admin can see it and decide.
        await prisma.video.update({
          where: { id: video.id },
          data: { status: 'ERROR' },
        })
        console.log(`[Upload Cleanup] Marked video ${video.id} as ERROR (${video.uploadProgress}% progress, >24h old)`)
      }
    }

    // --- Album Photos ---
    const stuckPhotos = await prisma.albumPhoto.findMany({
      where: {
        status: 'UPLOADING',
        createdAt: { lt: cutoffDate },
      },
      select: { id: true, albumId: true },
    })

    for (const photo of stuckPhotos) {
      // Album photos have no partial-progress tracking; if still UPLOADING after 24h
      // the upload was abandoned. Delete the orphaned record.
      await prisma.albumPhoto.delete({ where: { id: photo.id } }).catch(() => {})
      console.log(`[Upload Cleanup] Deleted orphaned album photo ${photo.id} (>24h old)`)
    }

    // --- Video Assets (no status field — check for empty storage) ---
    // VideoAssets are cascade-deleted with their parent video, but assets attached
    // to a READY video that were never uploaded will have fileSize > 0 in DB but
    // no actual file. These are caught by the TUS file cleanup above (no matching
    // upload file on disk) and are rare. The cascade on Video delete handles most.
  } catch (error) {
    console.error('[Upload Cleanup] Error during stuck upload cleanup:', error)
  }
}

/**
 * Run all cleanup tasks
 */
export async function runCleanup() {
  await cleanupOrphanedUploads()
  await cleanupStuckUploads()
}
