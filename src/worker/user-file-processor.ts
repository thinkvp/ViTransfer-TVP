import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { getFilePath } from '../lib/storage'
import { ALLOWED_ASSET_TYPES } from '../lib/file-validation'
import fs from 'fs'

const DEBUG = process.env.DEBUG_WORKER === 'true'

export interface UserFileProcessingJob {
  userFileId: string
  storagePath: string
  expectedCategory?: string
}

/**
 * Process uploaded user file - validate magic bytes (same safeguards as client files)
 */
export async function processUserFile(job: Job<UserFileProcessingJob>) {
  const { userFileId, storagePath, expectedCategory } = job.data

  console.log(`[WORKER] Processing user file ${userFileId}`)

  if (DEBUG) {
    console.log('[WORKER DEBUG] User file job data:', JSON.stringify(job.data, null, 2))
  }

  try {
    const filePath = getFilePath(storagePath)

    const stats = fs.statSync(filePath)
    if (stats.size === 0) {
      throw new Error('User file is empty')
    }

    const { fileTypeFromBuffer } = await import('file-type/core')

    const sampleSize = 4100
    const sampleBuffer = Buffer.alloc(Math.min(sampleSize, stats.size))
    const fileHandle = await fs.promises.open(filePath, 'r')
    try {
      await fileHandle.read(sampleBuffer, 0, sampleBuffer.length, 0)
    } finally {
      await fileHandle.close()
    }

    const fileType = await fileTypeFromBuffer(sampleBuffer)

    if (!fileType) {
      await prisma.userFile.update({
        where: { id: userFileId },
        data: {
          fileType: 'unknown',
          category: expectedCategory || 'other',
        },
      })

      console.log(`[WORKER] User file ${userFileId} processed (no magic bytes detected)`)
      return
    }

    let finalCategory: string

    if (expectedCategory && expectedCategory !== 'other') {
      const expectedConfig = ALLOWED_ASSET_TYPES[expectedCategory as keyof typeof ALLOWED_ASSET_TYPES]

      if (expectedConfig && expectedConfig.mimeTypes.includes(fileType.mime)) {
        finalCategory = expectedCategory
      } else {
        await prisma.userFile.update({
          where: { id: userFileId },
          data: { fileType: 'INVALID - ' + fileType.mime },
        })
        throw new Error(`File MIME type '${fileType.mime}' is not compatible with expected category '${expectedCategory}'`)
      }
    } else {
      let detectedCategory: string | undefined
      for (const [cat, config] of Object.entries(ALLOWED_ASSET_TYPES)) {
        if (config.mimeTypes.includes(fileType.mime)) {
          detectedCategory = cat
          break
        }
      }

      if (!detectedCategory) {
        await prisma.userFile.update({
          where: { id: userFileId },
          data: { fileType: 'INVALID - ' + fileType.mime },
        })
        throw new Error(`File content does not match any allowed asset type. Detected: ${fileType.mime}`)
      }

      finalCategory = detectedCategory
    }

    await prisma.userFile.update({
      where: { id: userFileId },
      data: {
        fileType: fileType.mime,
        category: finalCategory,
      },
    })

    console.log(`[WORKER] User file ${userFileId} processed successfully`)
  } catch (error) {
    console.error(`[WORKER ERROR] User file processing failed for ${userFileId}:`, error)
    throw error
  }
}
