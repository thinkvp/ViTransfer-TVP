import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { downloadFile } from '../lib/storage'
import { ALLOWED_ASSET_TYPES } from '../lib/file-validation'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { TEMP_DIR } from './cleanup'

const DEBUG = process.env.DEBUG_WORKER === 'true'

export interface ClientFileProcessingJob {
  clientFileId: string
  storagePath: string
  expectedCategory?: string
}

/**
 * Process uploaded client file - validate magic bytes (same safeguards as video assets)
 */
export async function processClientFile(job: Job<ClientFileProcessingJob>) {
  const { clientFileId, storagePath, expectedCategory } = job.data

  console.log(`[WORKER] Processing client file ${clientFileId}`)

  if (DEBUG) {
    console.log('[WORKER DEBUG] Client file job data:', JSON.stringify(job.data, null, 2))
  }

  let tempFilePath: string | undefined

  try {
    tempFilePath = path.join(TEMP_DIR, `${clientFileId}-clientfile`)

    const downloadStream = await downloadFile(storagePath)
    await pipeline(downloadStream, fs.createWriteStream(tempFilePath))

    const stats = fs.statSync(tempFilePath)
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty')
    }

    const { fileTypeFromBuffer } = await import('file-type/core')

    const sampleSize = 4100
    const sampleBuffer = Buffer.alloc(Math.min(sampleSize, stats.size))
    const fileHandle = await fs.promises.open(tempFilePath, 'r')
    try {
      await fileHandle.read(sampleBuffer, 0, sampleBuffer.length, 0)
    } finally {
      await fileHandle.close()
    }

    const fileType = await fileTypeFromBuffer(sampleBuffer)

    if (!fileType) {
      await prisma.clientFile.update({
        where: { id: clientFileId },
        data: {
          fileType: 'unknown',
          category: expectedCategory || 'other',
        },
      })

      console.log(`[WORKER] Client file ${clientFileId} processed (no magic bytes detected)`)
      return
    }

    let finalCategory: string

    if (expectedCategory && expectedCategory !== 'other') {
      const expectedConfig = ALLOWED_ASSET_TYPES[expectedCategory as keyof typeof ALLOWED_ASSET_TYPES]

      if (expectedConfig && expectedConfig.mimeTypes.includes(fileType.mime)) {
        finalCategory = expectedCategory
      } else {
        await prisma.clientFile.update({
          where: { id: clientFileId },
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
        await prisma.clientFile.update({
          where: { id: clientFileId },
          data: { fileType: 'INVALID - ' + fileType.mime },
        })
        throw new Error(`File content does not match any allowed asset type. Detected: ${fileType.mime}`)
      }

      finalCategory = detectedCategory
    }

    await prisma.clientFile.update({
      where: { id: clientFileId },
      data: {
        fileType: fileType.mime,
        category: finalCategory,
      },
    })

    console.log(`[WORKER] Client file ${clientFileId} processed successfully`)
  } catch (error) {
    console.error(`[WORKER ERROR] Client file processing failed for ${clientFileId}:`, error)
    throw error
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath)
      } catch (cleanupError) {
        console.error('[WORKER ERROR] Failed to cleanup temp file:', cleanupError)
      }
    }
  }
}
