import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { getFilePath } from '../lib/storage'
import { ALLOWED_ASSET_TYPES } from '../lib/file-validation'
import fs from 'fs'

const DEBUG = process.env.DEBUG_WORKER === 'true'

export interface ProjectFileProcessingJob {
  projectFileId: string
  storagePath: string
  expectedCategory?: string
}

/**
 * Process uploaded project file - validate magic bytes (same safeguards as video assets / client files)
 */
export async function processProjectFile(job: Job<ProjectFileProcessingJob>) {
  const { projectFileId, storagePath, expectedCategory } = job.data

  console.log(`[WORKER] Processing project file ${projectFileId}`)

  if (DEBUG) {
    console.log('[WORKER DEBUG] Project file job data:', JSON.stringify(job.data, null, 2))
  }

  try {
    // Read magic bytes directly from storage — no temp copy needed
    const filePath = getFilePath(storagePath)

    const stats = fs.statSync(filePath)
    if (stats.size === 0) {
      throw new Error('Project file is empty')
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
      await prisma.projectFile.update({
        where: { id: projectFileId },
        data: {
          fileType: 'unknown',
          category: expectedCategory || 'other',
        },
      })

      console.log(`[WORKER] Project file ${projectFileId} processed (no magic bytes detected)`) 
      return
    }

    let finalCategory: string

    if (expectedCategory && expectedCategory !== 'other') {
      const expectedConfig = ALLOWED_ASSET_TYPES[expectedCategory as keyof typeof ALLOWED_ASSET_TYPES]

      if (expectedConfig && expectedConfig.mimeTypes.includes(fileType.mime)) {
        finalCategory = expectedCategory
      } else {
        await prisma.projectFile.update({
          where: { id: projectFileId },
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
        await prisma.projectFile.update({
          where: { id: projectFileId },
          data: { fileType: 'INVALID - ' + fileType.mime },
        })
        throw new Error(`File content does not match any allowed asset type. Detected: ${fileType.mime}`)
      }

      finalCategory = detectedCategory
    }

    await prisma.projectFile.update({
      where: { id: projectFileId },
      data: {
        fileType: fileType.mime,
        category: finalCategory,
      },
    })

    console.log(`[WORKER] Project file ${projectFileId} processed successfully`)
  } catch (error) {
    console.error(`[WORKER ERROR] Project file processing failed for ${projectFileId}:`, error)
    throw error
  }
}
