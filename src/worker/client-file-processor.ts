import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { isS3Mode, s3ReadFileHeader, s3DownloadFileToBuffer } from '../lib/s3-storage'
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
    const { fileTypeFromBuffer } = await import('file-type/core')

    let sampleBuffer: Buffer
    // resolved is only set in non-S3 mode and may be used by the SVG branch below
    let resolved: { localPath: string; isTemporary: boolean } | undefined

    if (isS3Mode()) {
      // Ranged GET — only fetch the bytes needed for magic-byte detection
      const { data, totalSize } = await s3ReadFileHeader(storagePath, 4100)
      if (totalSize === 0) throw new Error('Client file is empty')
      sampleBuffer = data
    } else {
      resolved = await materializeStoragePathToLocalFile({
        rawPath: storagePath,
        tempDir: path.join(os.tmpdir(), 'vitransfer-file-tmp'),
        suggestedName: `${clientFileId}-file.bin`,
      })
      const filePath = resolved.localPath
      const stats = fs.statSync(filePath)
      if (stats.size === 0) throw new Error('Client file is empty')
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
      let raw: string
      if (isS3Mode()) {
        // Download full SVG from S3 into memory (SVGs are small)
        const buf = await s3DownloadFileToBuffer(storagePath)
        raw = buf.toString('utf8')
      } else {
        raw = await fs.promises.readFile(resolved!.localPath, 'utf8')
      }
      const sanitized = sanitizeSvgContent(raw)
      if (sanitized !== raw) {
        console.log(`[WORKER] Sanitizing SVG content for client file ${clientFileId}`)
        const buf = Buffer.from(sanitized, 'utf8')
        if (isS3Mode() || resolved?.isTemporary) {
          // Replace the stored object with the sanitized version
          await uploadFile(storagePath, buf, buf.length, 'image/svg+xml')
        } else {
          await fs.promises.writeFile(resolved!.localPath, buf)
        }
      }
    }

    console.log(`[WORKER] Client file ${clientFileId} processed successfully`)
  } catch (error) {
    console.error(`[WORKER ERROR] Client file processing failed for ${clientFileId}:`, error)
    throw error
  }
}
