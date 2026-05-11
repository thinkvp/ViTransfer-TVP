import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { materializeStoragePathToLocalFile } from '../lib/storage-provider'
import { uploadFile } from '../lib/storage'
import { ALLOWED_ASSET_TYPES } from '../lib/file-validation'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Strip dangerous content from SVG files before storage.
 * Removes <script> elements, event-handler attributes, and javascript: URIs.
 * This runs server-side in the worker as a defence-in-depth measure;
 * all SVG downloads are also served as attachments with
 * Content-Disposition: attachment and Content-Type: application/octet-stream.
 */
function sanitizeSvgContent(raw: string): string {
  // Remove <script>…</script> blocks
  let out = raw.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  // Remove event-handler attributes (onclick, onload, onerror, etc.)
  out = out.replace(/\s+on[a-z][a-z0-9]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
  // Neutralise javascript: URIs in href / xlink:href / src / action
  out = out.replace(
    /((?:xlink:)?href|src|action)\s*=\s*["']\s*javascript:[^"']*["']/gi,
    '$1=""'
  )
  return out
}

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

  try {
    // Resolve file to a local path — downloads from S3 if running in S3 mode
    const resolved = await materializeStoragePathToLocalFile({
      rawPath: storagePath,
      tempDir: path.join(os.tmpdir(), 'vitransfer-file-tmp'),
      suggestedName: `${clientFileId}-file.bin`,
    })
    const filePath = resolved.localPath

    const stats = fs.statSync(filePath)
    if (stats.size === 0) {
      throw new Error('Client file is empty')
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

    // Sanitize SVG content in-place to strip scripts and event handlers.
    // Defence-in-depth: downloads are also forced to attachment + octet-stream.
    if (fileType.mime === 'image/svg+xml') {
      const raw = await fs.promises.readFile(filePath, 'utf8')
      const sanitized = sanitizeSvgContent(raw)
      if (sanitized !== raw) {
        console.log(`[WORKER] Sanitizing SVG content for client file ${clientFileId}`)
        const buf = Buffer.from(sanitized, 'utf8')
        if (resolved.isTemporary) {
          // S3 mode: replace the stored object with the sanitized version
          await uploadFile(storagePath, buf, buf.length, 'image/svg+xml')
        } else {
          await fs.promises.writeFile(filePath, buf)
        }
      }
    }

    console.log(`[WORKER] Client file ${clientFileId} processed successfully`)
  } catch (error) {
    console.error(`[WORKER ERROR] Client file processing failed for ${clientFileId}:`, error)
    throw error
  }
}
