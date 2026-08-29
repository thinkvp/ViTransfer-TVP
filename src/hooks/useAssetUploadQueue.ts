import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import * as tus from 'tus-js-client'
import { apiPost, apiDelete, apiFetch, attemptRefresh } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { useTransferTuning } from '@/lib/transfer-tuning-client'
import {
  ensureFreshUploadOnContextChange,
  clearFileContext,
  getUploadMetadata,
  storeUploadMetadata,
  clearUploadMetadata,
  clearTUSFingerprint,
} from '@/lib/tus-context'
import { isS3Mode } from '@/lib/storage-provider-client'

export interface QueuedUpload {
  id: string
  file: File
  category: string
  assetId: string | null
  videoId: string

  // Status tracking
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null

  // TUS upload reference (local/TUS mode only)
  tusUpload: tus.Upload | null

  // S3 abort controller (S3 mode only)
  s3AbortController?: AbortController

  // Timestamps
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

interface UseAssetUploadQueueOptions {
  videoId: string
  maxConcurrent?: number
  onUploadComplete?: () => void
}

// ---------------------------------------------------------------------------
// Module-level store
//
// The queue deliberately lives outside React: the upload panel is unmounted
// whenever the user collapses the video version card, and an in-flight transfer
// must survive that (and be visible again on re-expand). Component state would
// be discarded while the XHR/TUS request kept running invisibly. Same idea as
// UploadManagerProvider does for video uploads, scoped per videoId.
// ---------------------------------------------------------------------------

const EMPTY_QUEUE: QueuedUpload[] = []

type QueueConfig = {
  maxConcurrent: number
  uploadChunkSizeBytes: number
  onUploadComplete?: () => void
}

const queues = new Map<string, QueuedUpload[]>()
const listeners = new Map<string, Set<() => void>>()
const configs = new Map<string, QueueConfig>()
const uploadRefsMap = new Map<string, tus.Upload>()
const s3AbortControllersMap = new Map<string, AbortController>()
const assetIdsMap = new Map<string, string>()
const refreshAttemptsMap = new Map<string, number>()
const clearTimersMap = new Map<string, ReturnType<typeof setTimeout>>()

function getQueue(videoId: string): QueuedUpload[] {
  return queues.get(videoId) ?? EMPTY_QUEUE
}

function emit(videoId: string) {
  const set = listeners.get(videoId)
  if (!set) return
  for (const listener of [...set]) listener()
}

function setQueueFor(videoId: string, updater: (prev: QueuedUpload[]) => QueuedUpload[]) {
  const prev = getQueue(videoId)
  const next = updater(prev)
  if (next === prev) return

  if (next.length === 0) {
    queues.delete(videoId)
  } else {
    queues.set(videoId, next)
  }

  emit(videoId)
}

function patchUpload(videoId: string, uploadId: string, patch: Partial<QueuedUpload>) {
  setQueueFor(videoId, prev => prev.map(u => (u.id === uploadId ? { ...u, ...patch } : u)))
}

function isActiveStatus(status: QueuedUpload['status']): boolean {
  return status === 'uploading' || status === 'queued' || status === 'paused'
}

/** True when this video version has uploads in flight (used to re-open the panel on re-mount). */
export function hasActiveAssetUploads(videoId: string): boolean {
  return getQueue(videoId).some(u => isActiveStatus(u.status))
}

/**
 * Queue asset uploads for a video WITHOUT the panel being mounted.
 *
 * The video-upload panel lets assets be chosen before the version exists, so by the time
 * they can be queued the target's own asset panel may never have rendered — and `pump`
 * bails when the video has no config entry. Seeds a config (the mounted panel overwrites
 * it with the live transfer tuning) and starts the queue; the panel picks the queue up
 * from the module store whenever it is opened.
 */
export function enqueueAssetUploads(
  videoId: string,
  items: Array<{ file: File; category: string }>,
  opts: { uploadChunkSizeBytes: number; maxConcurrent?: number },
): number {
  if (!videoId || items.length === 0) return 0

  if (!configs.has(videoId)) {
    configs.set(videoId, {
      maxConcurrent: opts.maxConcurrent ?? 3,
      uploadChunkSizeBytes: opts.uploadChunkSizeBytes,
    })
  }

  ensureBeforeUnloadGuard()
  setQueueFor(videoId, prev => [
    ...prev,
    ...items.map(({ file, category }) => createQueuedUpload(videoId, file, category)),
  ])
  pump(videoId)

  return items.length
}

// Warn before leaving the page while any asset upload is still running. Installed
// once, lazily — the guard outlives individual panels.
let beforeUnloadInstalled = false
function ensureBeforeUnloadGuard() {
  if (beforeUnloadInstalled || typeof window === 'undefined') return
  beforeUnloadInstalled = true

  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    let hasActive = false
    for (const q of queues.values()) {
      if (q.some(u => isActiveStatus(u.status))) {
        hasActive = true
        break
      }
    }
    if (!hasActive) return

    e.preventDefault()
    e.returnValue = '' // Chrome requires returnValue to be set
    return '' // Some browsers use the return value
  })
}

/**
 * Auto-clear a completed upload shortly after it finishes so the queue doesn't
 * accumulate finished rows — the asset list is the source of truth. Errors are
 * left in place so they remain visible for retry.
 */
function scheduleCompletedClear(videoId: string, uploadId: string) {
  if (clearTimersMap.has(uploadId)) return

  const timer = setTimeout(() => {
    clearTimersMap.delete(uploadId)
    setQueueFor(videoId, prev => prev.filter(u => u.id !== uploadId))
  }, 1500)

  clearTimersMap.set(uploadId, timer)
}

function generateUploadId(): string {
  const cryptoObj: Crypto | undefined = (globalThis as any).crypto
  if (cryptoObj?.randomUUID) {
    return `upload-${Date.now()}-${cryptoObj.randomUUID()}`
  }

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return `upload-${Date.now()}-${hex}`
  }

  // Fallback: use UUID (should be rare — crypto.randomUUID is available in all supported environments)
  return `upload-${Date.now()}-${crypto.randomUUID()}`
}

/** One queue row, shared by the hook's addToQueue and the standalone enqueue. */
function createQueuedUpload(videoId: string, file: File, category: string): QueuedUpload {
  return {
    id: generateUploadId(),
    file,
    category,
    assetId: null,
    videoId,
    status: 'queued',
    progress: 0,
    uploadSpeed: 0,
    error: null,
    tusUpload: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
  }
}

/** Start queued uploads while concurrency slots are free. Safe to call repeatedly. */
function pump(videoId: string) {
  const config = configs.get(videoId)
  if (!config) return

  // startUpload flips the row to 'uploading' synchronously (before its first
  // await), so re-read the queue each round rather than batching decisions.
  for (;;) {
    const q = getQueue(videoId)
    if (q.filter(u => u.status === 'uploading').length >= config.maxConcurrent) return

    const next = q.find(u => u.status === 'queued')
    if (!next) return

    void startUpload(videoId, next.id)

    // Defensive: if the row didn't leave 'queued', stop instead of spinning.
    if (getQueue(videoId).find(u => u.id === next.id)?.status === 'queued') return
  }
}

// Start an upload
async function startUpload(videoId: string, uploadId: string) {
  const upload = getQueue(videoId).find(u => u.id === uploadId)
  if (!upload || upload.status === 'uploading') return

  const uploadChunkSizeBytes = configs.get(videoId)?.uploadChunkSizeBytes
  const notifyComplete = () => configs.get(videoId)?.onUploadComplete?.()

  try {
    // Check if file was uploaded to different video and clear TUS fingerprint if needed
    ensureFreshUploadOnContextChange(upload.file, `${videoId}:${upload.category || 'default'}`)

    const existingMetadata = getUploadMetadata(upload.file)
    const canResumeExisting =
      existingMetadata?.videoId === videoId &&
      !!existingMetadata.assetId &&
      (existingMetadata.category || null) === (upload.category || null)
    let createdAssetRecord = false

    // Update status to uploading
    patchUpload(videoId, uploadId, { status: 'uploading', startedAt: Date.now(), error: null })

    // Create asset record if we don't have one stored
    let assetId: string
    if (canResumeExisting) {
      assetId = existingMetadata!.assetId!
      assetIdsMap.set(uploadId, assetId)
      storeUploadMetadata(upload.file, {
        videoId,
        assetId,
        category: upload.category,
      })
    } else {
      const response = await apiPost(`/api/videos/${videoId}/assets`, {
        fileName: upload.file.name,
        fileSize: upload.file.size,
        category: upload.category || null,
      })

      assetId = response.assetId
      assetIdsMap.set(uploadId, assetId)
      createdAssetRecord = true

      storeUploadMetadata(upload.file, {
        videoId,
        assetId,
        category: upload.category,
      })
    }

    // -----------------------------------------------------------------------
    // S3 mode: browser-direct multipart upload
    // -----------------------------------------------------------------------
    if (await isS3Mode()) {
      const abortController = new AbortController()
      s3AbortControllersMap.set(uploadId, abortController)
      const signal = abortController.signal

      let s3UploadId: string | null = null
      let s3Key: string | null = null

      let parts: Array<{ partNumber: number; url: string }> = []
      let partSize = 0

      try {
        // Step 1: Presign
        const presignRes = await apiFetch('/api/upload-s3/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assetId,
            fileSize: upload.file.size,
            fileName: upload.file.name,
            contentType: upload.file.type || 'application/octet-stream',
          }),
          signal,
        })

        if (!presignRes.ok) {
          const errBody = await presignRes.json().catch(() => ({ error: 'Presign failed' }))
          // If presign fails with a 404 and we were trying to resume an existing
          // asset record (e.g. the asset was deleted server-side but localStorage
          // still has the stale assetId), clear the stale metadata, create a fresh
          // asset record, and retry the upload.
          if (presignRes.status === 404 && canResumeExisting) {
            clearUploadMetadata(upload.file)
            clearTUSFingerprint(upload.file)
            const retryResponse = await apiPost(`/api/videos/${videoId}/assets`, {
              fileName: upload.file.name,
              fileSize: upload.file.size,
              category: upload.category || null,
            })
            assetId = retryResponse.assetId
            assetIdsMap.set(uploadId, assetId)
            createdAssetRecord = true
            storeUploadMetadata(upload.file, {
              videoId,
              assetId,
              category: upload.category,
            })
            // Retry presign with the fresh assetId
            const retryPresignRes = await apiFetch('/api/upload-s3/presign', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                assetId,
                fileSize: upload.file.size,
                fileName: upload.file.name,
                contentType: upload.file.type || 'application/octet-stream',
              }),
              signal,
            })
            if (!retryPresignRes.ok) {
              const retryErrBody = await retryPresignRes.json().catch(() => ({ error: 'Presign failed' }))
              throw new Error(retryErrBody.error ?? 'Presign failed')
            }
            const presignData = await retryPresignRes.json()
            s3UploadId = presignData.uploadId
            s3Key = presignData.key
            parts = presignData.parts
            partSize = presignData.partSize
          } else {
            throw new Error(errBody.error ?? 'Presign failed')
          }
        } else {
          const presignData = await presignRes.json()
          s3UploadId = presignData.uploadId
          s3Key = presignData.key
          parts = presignData.parts
          partSize = presignData.partSize
        }

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        // Step 2: Upload all parts directly to R2
        const uploadFile = upload.file
        const totalBytes = uploadFile.size
        const completedParts: Array<{ partNumber: number; etag: string }> = new Array(parts.length)

        const MAX_CONCURRENT = 4
        let nextPartIdx = 0
        let totalSentBytes = 0
        let speedWindowStartTime = Date.now()
        let speedWindowStartBytes = 0
        let displaySpeedMBps = 0

        const patchProgress = () => {
          const progress = Math.floor((totalSentBytes / totalBytes) * 100)
          setQueueFor(videoId, prev => prev.map(u =>
            u.id === uploadId
              ? { ...u, progress: Math.min(progress, 99), uploadSpeed: displaySpeedMBps > 0.05 ? Math.round(displaySpeedMBps * 10) / 10 : u.uploadSpeed }
              : u
          ))
        }

        async function uploadWorker() {
          while (nextPartIdx < parts.length) {
            const i = nextPartIdx++
            const part = parts[i]
            const start = i * partSize
            const end = Math.min(start + partSize, uploadFile.size)
            const slice = uploadFile.slice(start, end)
            const partBytes = end - start

            const etag = await new Promise<string>((resolve, reject) => {
              if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
              const xhr = new XMLHttpRequest()
              xhr.open('PUT', part.url)
              let lastLoaded = 0
              xhr.upload.addEventListener('progress', (e) => {
                const delta = e.loaded - lastLoaded
                if (delta <= 0) return
                lastLoaded = e.loaded
                totalSentBytes = Math.min(totalSentBytes + delta, totalBytes)
                const now = Date.now()
                const timeDiff = (now - speedWindowStartTime) / 1000
                if (timeDiff >= 0.5) {
                  const bytesDiff = totalSentBytes - speedWindowStartBytes
                  displaySpeedMBps = bytesDiff / timeDiff / (1024 * 1024)
                  speedWindowStartTime = now
                  speedWindowStartBytes = totalSentBytes
                }
                patchProgress()
              })
              xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  const trailingDelta = partBytes - lastLoaded
                  if (trailingDelta > 0) {
                    totalSentBytes = Math.min(totalSentBytes + trailingDelta, totalBytes)
                    patchProgress()
                  }
                  const etag = xhr.getResponseHeader('ETag') ?? xhr.getResponseHeader('etag')
                  etag ? resolve(etag) : reject(new Error('No ETag in response'))
                } else {
                  reject(new Error(`Part upload failed: ${xhr.status}`))
                }
              })
              xhr.addEventListener('error', () => reject(new Error('Network error during part upload')))
              xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
              const onAbort = () => xhr.abort()
              signal.addEventListener('abort', onAbort, { once: true })
              xhr.addEventListener('loadend', () => signal.removeEventListener('abort', onAbort))
              xhr.send(slice)
            })

            completedParts[i] = { partNumber: part.partNumber, etag }
          }
        }

        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, parts.length) }, uploadWorker))

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        // Step 3: Complete
        const completeRes = await apiFetch('/api/upload-s3/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId, uploadId: s3UploadId, key: s3Key, parts: completedParts }),
        })

        if (!completeRes.ok) {
          const errBody = await completeRes.json().catch(() => ({ error: 'Complete failed' }))
          throw new Error(errBody.error ?? 'Complete failed')
        }

        patchUpload(videoId, uploadId, { status: 'completed', progress: 100, uploadSpeed: 0, completedAt: Date.now() })
        scheduleCompletedClear(videoId, uploadId)
        s3AbortControllersMap.delete(uploadId)
        assetIdsMap.delete(uploadId)
        notifyComplete()
        pump(videoId)
      } catch (err: any) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Cancelled — clean up R2 partial upload
          if (s3UploadId && s3Key) {
            apiFetch('/api/upload-s3/abort', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ assetId, uploadId: s3UploadId, key: s3Key }),
            }).catch(() => undefined)
          }
          pump(videoId)
          return
        }
        const errorMessage = err?.message ?? 'Upload failed'
        patchUpload(videoId, uploadId, { status: 'error', error: errorMessage })
        s3AbortControllersMap.delete(uploadId)
        assetIdsMap.delete(uploadId)
        pump(videoId)
      }
      return
    }

    // -----------------------------------------------------------------------
    // TUS mode: local storage — upload via TUS protocol
    // -----------------------------------------------------------------------

    // Start TUS upload
    const startTime = Date.now()
    let lastLoaded = 0
    let lastTime = startTime

    const tusUpload = new tus.Upload(upload.file, {
      endpoint: `${window.location.origin}/api/uploads`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: {
        filename: upload.file.name,
        filetype: upload.file.type || 'application/octet-stream',
        assetId: assetId,
      },
      chunkSize: uploadChunkSizeBytes,
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,

      onProgress: (bytesUploaded, bytesTotal) => {
        const percentage = Math.round((bytesUploaded / bytesTotal) * 100)

        // Calculate upload speed
        const now = Date.now()
        const timeDiff = (now - lastTime) / 1000
        const bytesDiff = bytesUploaded - lastLoaded

        let speedMBps = 0
        if (timeDiff > 0.5) {
          speedMBps = (bytesDiff / timeDiff) / (1024 * 1024)
          lastLoaded = bytesUploaded
          lastTime = now
        }

        setQueueFor(videoId, prev => prev.map(u =>
          u.id === uploadId
            ? {
                ...u,
                progress: percentage,
                // Keep last stable speed to avoid flicker between 0 and a value
                uploadSpeed:
                  speedMBps > 0.05
                    ? Math.round(speedMBps * 10) / 10
                    : u.uploadSpeed
              }
            : u
        ))
      },

      onSuccess: () => {
        patchUpload(videoId, uploadId, { status: 'completed', progress: 100, completedAt: Date.now() })
        scheduleCompletedClear(videoId, uploadId)

        uploadRefsMap.delete(uploadId)
        assetIdsMap.delete(uploadId)
        refreshAttemptsMap.delete(uploadId)

        // Clear file context since upload completed
        clearFileContext(upload.file)
        clearUploadMetadata(upload.file)
        clearTUSFingerprint(upload.file)

        notifyComplete()

        pump(videoId)
      },

      onError: async (error) => {
        let errorMessage = 'Upload failed'

        if (error.message?.includes('NetworkError') || error.message?.includes('Failed to fetch')) {
          errorMessage = 'Network error. Please check your connection and try again.'
        } else if (error.message?.includes('413')) {
          errorMessage = 'File is too large. Please choose a smaller file.'
        } else if (error.message?.includes('401') || error.message?.includes('403')) {
          errorMessage = 'Authentication failed. Please log in again.'
        } else if (error.message?.includes('404')) {
          errorMessage = 'Upload endpoint not found. Check server logs.'
        } else if (error.message?.includes('500')) {
          errorMessage = 'Server error. Check server logs for details.'
        } else if (error.message) {
          errorMessage = error.message
        }

        const statusCode = (error as any)?.originalResponse?.getStatus?.()

        // If auth failed, attempt a single refresh and resume the upload.
        if (statusCode === 401 || statusCode === 403) {
          const attempts = refreshAttemptsMap.get(uploadId) || 0
          if (attempts < 1) {
            refreshAttemptsMap.set(uploadId, attempts + 1)
            const refreshed = await attemptRefresh()
            if (refreshed) {
              try {
                tusUpload.start()
                return
              } catch {
                // fall through to normal error handling
              }
            }
          }
        }

        // Clean up asset record on error
        const currentAssetId = assetIdsMap.get(uploadId)
        if (currentAssetId) {
          // If resume session is gone, clear local resume data and keep the DB record (user can retry fresh)
          if (canResumeExisting && (statusCode === 404 || statusCode === 410)) {
            clearUploadMetadata(upload.file)
            clearTUSFingerprint(upload.file)
            errorMessage = 'Upload session expired. Please restart the upload.'
          } else if (createdAssetRecord) {
            try {
              await apiDelete(`/api/videos/${videoId}/assets/${currentAssetId}`)
            } catch {}
            clearUploadMetadata(upload.file)
            clearTUSFingerprint(upload.file)
          }
          assetIdsMap.delete(uploadId)
        }

        patchUpload(videoId, uploadId, { status: 'error', error: errorMessage })

        uploadRefsMap.delete(uploadId)
        refreshAttemptsMap.delete(uploadId)

        pump(videoId)
      },

      onBeforeRequest: (req) => {
        const xhr = req.getUnderlyingObject()
        xhr.withCredentials = true

        // Always use the latest access token (it may rotate on refresh)
        const token = getAccessToken()
        if (token) {
          if (xhr?.setRequestHeader) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          } else {
            req.setHeader('Authorization', `Bearer ${token}`)
          }
        }
      },
    })

    const previousUploads = await tusUpload.findPreviousUploads()
    if (previousUploads.length > 0) {
      tusUpload.resumeFromPreviousUpload(previousUploads[0])
    } else if (!createdAssetRecord && canResumeExisting) {
      // We expected to resume but no session exists; clear stale metadata so next attempt starts fresh
      clearUploadMetadata(upload.file)
      clearTUSFingerprint(upload.file)
    }

    uploadRefsMap.set(uploadId, tusUpload)
    tusUpload.start()
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Upload failed'
    patchUpload(videoId, uploadId, { status: 'error', error: errorMessage })
    refreshAttemptsMap.delete(uploadId)
    pump(videoId)
  }
}

// ---------------------------------------------------------------------------
// Hook — a thin view onto the store above
// ---------------------------------------------------------------------------

export function useAssetUploadQueue({
  videoId,
  maxConcurrent = 3,
  onUploadComplete
}: UseAssetUploadQueueOptions) {
  const { uploadChunkSizeBytes } = useTransferTuning()

  const subscribe = useCallback((notify: () => void) => {
    let set = listeners.get(videoId)
    if (!set) {
      set = new Set()
      listeners.set(videoId, set)
    }
    set.add(notify)

    return () => {
      set!.delete(notify)
      if (set!.size === 0) listeners.delete(videoId)
    }
  }, [videoId])

  const queue = useSyncExternalStore(
    subscribe,
    () => getQueue(videoId),
    () => EMPTY_QUEUE,
  )

  // Keep the store's per-video config current, and pick up anything left queued
  // while the panel was unmounted.
  useEffect(() => {
    configs.set(videoId, { maxConcurrent, uploadChunkSizeBytes, onUploadComplete })
    pump(videoId)

    return () => {
      // Drop the completion callback (its component is going away) but keep the
      // transfer settings so in-flight uploads can carry on while unmounted.
      const config = configs.get(videoId)
      if (config && config.onUploadComplete === onUploadComplete) {
        configs.set(videoId, { ...config, onUploadComplete: undefined })
      }
    }
  }, [videoId, maxConcurrent, uploadChunkSizeBytes, onUploadComplete])

  // Add file to queue
  const addToQueue = useCallback((file: File, category: string): string => {
    const newUpload = createQueuedUpload(videoId, file, category)

    ensureBeforeUnloadGuard()
    setQueueFor(videoId, prev => [...prev, newUpload])
    pump(videoId)

    return newUpload.id
  }, [videoId])

  // Pause an upload (TUS only; S3 mode uploads cannot be paused)
  const pauseUpload = useCallback((uploadId: string) => {
    if (s3AbortControllersMap.has(uploadId)) return
    const tusUpload = uploadRefsMap.get(uploadId)
    if (tusUpload) {
      tusUpload.abort()
      patchUpload(videoId, uploadId, { status: 'paused' })
      pump(videoId)
    }
  }, [videoId])

  // Resume an upload (TUS only)
  const resumeUpload = useCallback((uploadId: string) => {
    if (s3AbortControllersMap.has(uploadId)) return
    const tusUpload = uploadRefsMap.get(uploadId)
    if (tusUpload) {
      tusUpload.start()
      patchUpload(videoId, uploadId, { status: 'uploading' })
    }
  }, [videoId])

  // Cancel an upload
  const cancelUpload = useCallback(async (uploadId: string) => {
    const upload = getQueue(videoId).find(u => u.id === uploadId)

    const s3Controller = s3AbortControllersMap.get(uploadId)
    if (s3Controller) {
      s3Controller.abort()
      s3AbortControllersMap.delete(uploadId)
    } else {
      const tusUpload = uploadRefsMap.get(uploadId)
      if (tusUpload) {
        tusUpload.abort(true)
      }
      uploadRefsMap.delete(uploadId)
    }

    // Clean up asset record
    const assetId = assetIdsMap.get(uploadId)
    if (assetId) {
      try {
        await apiDelete(`/api/videos/${videoId}/assets/${assetId}`)
      } catch {}
    }

    assetIdsMap.delete(uploadId)
    refreshAttemptsMap.delete(uploadId)

    // Remove from queue
    setQueueFor(videoId, prev => prev.filter(u => u.id !== uploadId))

    if (upload) {
      clearUploadMetadata(upload.file)
      clearTUSFingerprint(upload.file)
      clearFileContext(upload.file)
    }

    pump(videoId)
  }, [videoId])

  // Remove completed upload from queue
  const removeCompleted = useCallback((uploadId: string) => {
    setQueueFor(videoId, prev => prev.filter(u => u.id !== uploadId))
  }, [videoId])

  // Clear all completed uploads
  const clearCompleted = useCallback(() => {
    setQueueFor(videoId, prev => prev.filter(u => u.status !== 'completed'))
  }, [videoId])

  // Retry failed upload
  const retryUpload = useCallback((uploadId: string) => {
    patchUpload(videoId, uploadId, { status: 'queued', error: null, progress: 0, uploadSpeed: 0 })
    pump(videoId)
  }, [videoId])

  const startUploadById = useCallback((uploadId: string) => {
    void startUpload(videoId, uploadId)
  }, [videoId])

  // Get queue statistics
  const stats = useMemo(() => ({
    total: queue.length,
    queued: queue.filter(u => u.status === 'queued').length,
    uploading: queue.filter(u => u.status === 'uploading').length,
    paused: queue.filter(u => u.status === 'paused').length,
    completed: queue.filter(u => u.status === 'completed').length,
    error: queue.filter(u => u.status === 'error').length,
  }), [queue])

  return {
    queue,
    stats,
    addToQueue,
    startUpload: startUploadById,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    removeCompleted,
    clearCompleted,
    retryUpload,
  }
}
