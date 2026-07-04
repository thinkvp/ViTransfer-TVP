import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { isS3Mode, s3ReadFileHeader } from '../lib/s3-storage'
import { materializeStoragePathToLocalFile } from '../lib/storage-provider'
import { ALLOWED_ASSET_TYPES } from '../lib/file-validation'
import fs from 'fs'
import os from 'os'
import path from 'path'

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
    const { fileTypeFromBuffer } = await import('file-type')

    let sampleBuffer: Buffer

    if (isS3Mode()) {
      // Ranged GET — only fetch the bytes needed for magic-byte detection
      const { data, totalSize } = await s3ReadFileHeader(storagePath, 4100)
      if (totalSize === 0) throw new Error('Project file is empty')
      sampleBuffer = data
    } else {
      const resolved = await materializeStoragePathToLocalFile({
        rawPath: storagePath,
        tempDir: path.join(os.tmpdir(), 'vitransfer-file-tmp'),
        suggestedName: `${projectFileId}-file.bin`,
      })
      const filePath = resolved.localPath
      const stats = fs.statSync(filePath)
      if (stats.size === 0) throw new Error('Project file is empty')
      const buf = Buffer.alloc(Math.min(4100, stats.size))
      const fh = await fs.promises.open(filePath, 'r')
      try {
        await fh.read(buf, 0, buf.length, 0)
      } finally {
        await fh.close()
      }
      sampleBuffer = buf
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
