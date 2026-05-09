'use client'

/**
 * Browser-direct S3 multipart upload hook.
 *
 * Uploads files directly to Cloudflare R2 using presigned URLs,
 * bypassing the server for file data entirely (only auth/presign goes through server).
 *
 * Flow:
 * 1. POST /api/uploads/s3/presign  → get uploadId + presigned part URLs
 * 2. PUT each part directly to R2 using the presigned URLs (parallel up to concurrency limit)
 * 3. POST /api/uploads/s3/complete → finalize upload, trigger processing
 *
 * On error / cancel: POST /api/uploads/s3/abort → clean up R2 parts
 */

import { useCallback, useRef } from 'react'
import { apiFetch } from '@/lib/api-client'

export type S3UploadOptions = {
  videoId?: string
  assetId?: string
  file: File
  /** Called on each progress update (0–100). */
  onProgress?: (progress: number, speedMBps: number) => void
  /** Called when upload completes successfully. */
  onSuccess?: () => void
  /** Called when upload fails. */
  onError?: (error: string) => void
  /** Called when upload is aborted. */
  onAbort?: () => void
}

export type S3UploadController = {
  /** Abort the in-progress upload. */
  abort: () => void
}

type PresignResponse = {
  uploadId: string
  key: string
  parts: Array<{ partNumber: number; url: string }>
  partSize: number
}

type CompletedPart = {
  partNumber: number
  etag: string
}

// Maximum parallel part uploads at a time
const MAX_CONCURRENT_PARTS = 4

/**
 * Upload a single part to the presigned URL and return the ETag.
 */
async function uploadPart(
  url: string,
  data: Blob,
  signal: AbortSignal,
  onBytes?: (bytes: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)

    // Track upload progress for this part
    if (onBytes) {
      let lastLoaded = 0
      xhr.upload.addEventListener('progress', (e) => {
        const delta = e.loaded - lastLoaded
        if (delta > 0) {
          onBytes(delta)
          lastLoaded = e.loaded
        }
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') ?? xhr.getResponseHeader('etag')
        if (!etag) {
          reject(new Error(`Part upload succeeded but no ETag returned (status ${xhr.status})`))
          return
        }
        resolve(etag)
      } else {
        reject(new Error(`Part upload failed with status ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Network error during part upload')))
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))

    const unsubscribe = () => {
      xhr.abort()
    }
    signal.addEventListener('abort', unsubscribe, { once: true })
    xhr.addEventListener('loadend', () => signal.removeEventListener('abort', unsubscribe))

    xhr.send(data)
  })
}

/**
 * Run tasks with bounded concurrency.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      results[i] = await tasks[i]()
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

/**
 * Hook that exposes a startUpload function returning an AbortController-like object.
 */
export function useS3MultipartUpload() {
  const abortRef = useRef<AbortController | null>(null)

  const startUpload = useCallback(async (options: S3UploadOptions): Promise<S3UploadController> => {
    const { file, videoId, assetId, onProgress, onSuccess, onError, onAbort } = options

    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    let uploadId: string | null = null
    let key: string | null = null

    const abort = () => {
      controller.abort()
    }

    ;(async () => {
      try {
        // Step 1: Get presigned part URLs from our server
        const presignResponse = await apiFetch('/api/uploads/s3/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(videoId ? { videoId } : { assetId }),
            fileSize: file.size,
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
          }),
          signal,
        })

        if (!presignResponse.ok) {
          const err = await presignResponse.json().catch(() => ({ error: 'Presign request failed' }))
          throw new Error(err.error ?? 'Presign request failed')
        }

        const presignRes: PresignResponse = await presignResponse.json()
        uploadId = presignRes.uploadId
        key = presignRes.key

        const { parts, partSize } = presignRes

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        // Step 2: Upload all parts directly to R2 (browser → R2, bypasses server)
        const totalBytes = file.size
        let uploadedBytes = 0
        let lastTime = Date.now()
        let lastBytes = 0

        const completedParts: CompletedPart[] = new Array(parts.length)

        const partTasks = parts.map((part, i) => async () => {
          const start = i * partSize
          const end = Math.min(start + partSize, file.size)
          const slice = file.slice(start, end)

          const etag = await uploadPart(part.url, slice, signal, (bytes) => {
            uploadedBytes += bytes
            const now = Date.now()
            if (now - lastTime >= 500) {
              const elapsed = (now - lastTime) / 1000
              const bytesDiff = uploadedBytes - lastBytes
              const speedMBps = elapsed > 0 ? bytesDiff / elapsed / (1024 * 1024) : 0
              lastTime = now
              lastBytes = uploadedBytes
              const progress = Math.round((uploadedBytes / totalBytes) * 100)
              onProgress?.(Math.min(progress, 99), Math.round(speedMBps * 10) / 10)
            }
          })

          completedParts[i] = { partNumber: part.partNumber, etag }
        })

        await runWithConcurrency(partTasks, MAX_CONCURRENT_PARTS)

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        // Step 3: Tell our server to finalize the multipart upload
        const completeResponse = await apiFetch('/api/uploads/s3/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(videoId ? { videoId } : { assetId }),
            uploadId,
            key,
            parts: completedParts,
          }),
        })

        if (!completeResponse.ok) {
          const err = await completeResponse.json().catch(() => ({ error: 'Complete request failed' }))
          throw new Error(err.error ?? 'Complete request failed')
        }

        onProgress?.(100, 0)
        onSuccess?.()
      } catch (error: any) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Clean up the partial upload on R2 (best-effort)
          if (uploadId && key) {
            apiFetch('/api/uploads/s3/abort', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(videoId ? { videoId } : { assetId }),
                uploadId,
                key,
              }),
            }).catch(() => undefined)
          }
          onAbort?.()
          return
        }

        let errorMessage = error?.message ?? 'Upload failed'
        if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
          errorMessage = 'Network error — check your connection.'
        }

        // Clean up partial upload (best-effort)
        if (uploadId && key) {
          apiFetch('/api/uploads/s3/abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(videoId ? { videoId } : { assetId }),
              uploadId,
              key,
            }),
          }).catch(() => undefined)
        }

        onError?.(errorMessage)
      }
    })()

    return { abort }
  }, [])

  return { startUpload }
}
