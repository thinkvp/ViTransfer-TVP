import path from 'path'
import fs from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { getFilePath } from '@/lib/storage'
import {
  isS3Mode,
  s3DownloadFile,
} from '@/lib/s3-storage'

function sanitizeTempFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ._&-]/g, '_') || 'file.bin'
}

export async function materializeStoragePathToLocalFile(params: {
  rawPath: string
  tempDir: string
  suggestedName: string
  onProgress?: (transferred: number, total: number) => void
}): Promise<{ localPath: string; isTemporary: boolean }> {
  // S3 mode: download from R2 to a temp file for local processing (e.g. FFmpeg)
  if (isS3Mode()) {
    await fs.promises.mkdir(params.tempDir, { recursive: true })
    const tempPath = path.join(params.tempDir, sanitizeTempFileName(params.suggestedName))
    const { stream, contentLength } = await s3DownloadFile(params.rawPath)
    const writeStream = fs.createWriteStream(tempPath)
    if (params.onProgress && contentLength > 0) {
      let transferred = 0
      const onProgress = params.onProgress
      const tracker = new Transform({
        transform(chunk, _enc, cb) {
          transferred += chunk.length
          onProgress(transferred, contentLength)
          cb(null, chunk)
        },
      })
      await pipeline(stream as any, tracker, writeStream)
    } else {
      await pipeline(stream as any, writeStream)
    }
    return { localPath: tempPath, isTemporary: true }
  }

  return {
    localPath: getFilePath(params.rawPath),
    isTemporary: false,
  }
}