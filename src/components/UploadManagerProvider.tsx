'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { getAccessToken } from '@/lib/token-store'
import { apiFetch, apiDelete, apiPost } from '@/lib/api-client'
import { useTransferTuning } from '@/lib/transfer-tuning-client'
import { isS3Mode } from '@/lib/storage-provider-client'
import {
  clearFileContext,
  clearTUSFingerprint,
  clearUploadMetadata,
  storeUploadMetadata,
} from '@/lib/tus-context'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UploadJobStatus = 'queued' | 'uploading' | 'paused' | 'success' | 'error'

/** Serialisable upload job (no File / TUS refs). */
export type UploadJob = {
  id: string
  projectId: string
  videoId: string
  videoName: string
  versionLabel: string | null
  fileName: string
  fileSize: number
  progress: number
  speed: number
  status: UploadJobStatus
  error: string | null
  createdAt: number
  completedAt: number | null
}

/** Server-side processing job from polling. */
export type ProcessingJob = {
  id: string
  projectId: string
  projectName: string
  videoName: string
  versionLabel: string | null
  status: 'UPLOADING' | 'QUEUED' | 'PROCESSING' | 'READY'
  processingProgress: number
  processingPhase: string | null
  allocatedThreads: number | null
  threadBudget: number | null
}

/** Album ZIP generation job (polled from BullMQ via server). */
export type AlbumZipJob = {
  id: string
  albumId: string
  albumName: string
  projectId: string
  projectName: string
  variant: 'full' | 'social'
  status: 'PENDING' | 'ACTIVE'
}

export type AlbumThumbnailJob = {
  id: string
  albumId: string
  albumName: string
  projectId: string
  projectName: string
  status: 'PENDING' | 'IN_PROGRESS'
  totalPhotos: number
  processedPhotos: number
  totalBytes: string
  processedBytes: string
}

export type FolderRenameJob = {
  id: string
  entityType: 'PROJECT' | 'CLIENT' | 'VIDEO_GROUP' | 'ALBUM'
  entityId: string
  entityName: string
  status: 'PENDING' | 'IN_PROGRESS'
  totalObjects: number
  copiedObjects: number
  totalBytes: string // BigInt serialised as string
  copiedBytes: string // BigInt serialised as string
}

/** A server-side job that has recently completed (kept for 30 min). */
export type CompletedServerJob = {
  id: string
  type: 'processing' | 'albumZip' | 'albumThumbnail' | 'folderRename'
  label: string
  sublabel: string
  projectId: string
  completedAt: number
  /** True when the job finished with an error (not a successful completion). */
  error?: boolean
}

export type ClearRunningJobTarget = {
  type: 'processing' | 'albumZip' | 'albumThumbnail' | 'folderRename'
  id: string
}

function getCompletedServerJobKey(job: Pick<CompletedServerJob, 'id' | 'type'>): string {
  return `${job.type}:${job.id}`
}

function getCompletedServerJobKeyByParts(type: CompletedServerJob['type'], id: string): string {
  return `${type}:${id}`
}

const DISMISSED_SERVER_JOB_STORAGE_KEY = 'vitransfer-dismissed-running-jobs-v1'

function loadDismissedServerJobIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()

  try {
    const raw = window.localStorage.getItem(DISMISSED_SERVER_JOB_STORAGE_KEY)
    if (!raw) return new Set()

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()

    return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
  } catch {
    return new Set()
  }
}

function persistDismissedServerJobIds(ids: Set<string>) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(DISMISSED_SERVER_JOB_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore storage failures (private mode / quota issues)
  }
}

export type StartUploadConfig = {
  file: File
  projectId: string
  videoId: string
  videoName: string
  versionLabel?: string
  onComplete?: () => void
}

export type UploadManagerContextType = {
  /** Active / queued / recently-completed upload jobs. */
  uploads: UploadJob[]
  /** Server-side queued/processing jobs, including READY timeline-only work (polled). */
  processingJobs: ProcessingJob[]
  /** Album ZIP generation jobs (polled from queue). */
  albumZipJobs: AlbumZipJob[]
  /** Album thumbnail generation jobs (polled from DB). */
  albumThumbnailJobs: AlbumThumbnailJob[]
  /** Active folder rename jobs (polled). */
  folderRenameJobs: FolderRenameJob[]
  /** Recently completed server-side jobs (kept for 30 min). */
  completedServerJobs: CompletedServerJob[]
  /** Badge count: queued + uploading + paused + processing + album jobs. */
  totalActiveCount: number
  /** Enqueue a new upload. Returns the job ID. */
  addUpload: (config: StartUploadConfig) => string
  /** Permanently abort and remove an upload. */
  cancelUpload: (id: string) => void
  /** Pause an active upload. */
  pauseUpload: (id: string) => void
  /** Resume a paused upload. */
  resumeUpload: (id: string) => void
  /** Remove a finished (success / error) job from the list. */
  dismissUpload: (id: string) => void
  /** Remove a completed server-side job from the list. */
  dismissCompletedJob: (id: string) => void
  /** Clear a queued server-side job and try to remove it from BullMQ too. */
  clearRunningJob: (target: ClearRunningJobTarget) => Promise<void>
  /** Notify the provider when the Running Jobs dropdown opens/closes (adjusts poll rate). */
  setDropdownOpen: (open: boolean) => void
}

type UploadManagerActionsContextType = Pick<
  UploadManagerContextType,
  'addUpload' | 'cancelUpload' | 'pauseUpload' | 'resumeUpload' | 'dismissUpload' | 'dismissCompletedJob' | 'clearRunningJob' | 'setDropdownOpen'
>

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type InternalJob = UploadJob & {
  file: File
  tusUpload: tus.Upload | null
  /** AbortController for S3 multipart uploads (set in S3 mode instead of tusUpload). */
  s3AbortController?: AbortController
  onComplete?: () => void
  cancelled?: boolean
  /** Speed-calculation scratch */
  _lastLoaded: number
  _lastTime: number
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const UploadManagerContext = createContext<UploadManagerContextType | null>(null)
const UploadManagerActionsContext = createContext<UploadManagerActionsContextType | null>(null)

export function useUploadManager() {
  const ctx = useContext(UploadManagerContext)
  if (!ctx) throw new Error('useUploadManager must be used within UploadManagerProvider')
  return ctx
}

export function useUploadManagerActions() {
  const ctx = useContext(UploadManagerActionsContext)
  if (!ctx) throw new Error('useUploadManagerActions must be used within UploadManagerProvider')
  return ctx
}

/**
 * Optional hook — returns context or null if not inside the provider.
 * Useful for components that may render outside the admin layout.
 */
export function useUploadManagerOptional(): UploadManagerContextType | null {
  return useContext(UploadManagerContext)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_UPLOADS = 1

export function UploadManagerProvider({ children }: { children: React.ReactNode }) {
  const { uploadChunkSizeBytes } = useTransferTuning()

  // Internal mutable list — avoids stale-closure issues in TUS callbacks.
  const jobsRef = useRef<InternalJob[]>([])
  const activeIdsRef = useRef<Set<string>>(new Set())

  // React state for consumers.
  const [uploads, setUploads] = useState<UploadJob[]>([])
  const [processingJobs, setProcessingJobs] = useState<ProcessingJob[]>([])
  const [albumZipJobs, setAlbumZipJobs] = useState<AlbumZipJob[]>([])
  const [albumThumbnailJobs, setAlbumThumbnailJobs] = useState<AlbumThumbnailJob[]>([])
  const [folderRenameJobs, setFolderRenameJobs] = useState<FolderRenameJob[]>([])
  const [completedServerJobs, setCompletedServerJobs] = useState<CompletedServerJob[]>([])

  // Track previously-seen job IDs so we can detect completions.
  const prevProcessingIdsRef = useRef<Set<string>>(new Set())
  const prevAlbumZipIdsRef = useRef<Set<string>>(new Set())
  const prevAlbumThumbnailIdsRef = useRef<Set<string>>(new Set())
  const prevFolderRenameIdsRef = useRef<Set<string>>(new Set())
  // Map id → job metadata for building completion entries.
  const prevProcessingMapRef = useRef<Map<string, ProcessingJob>>(new Map())
  const prevAlbumZipMapRef = useRef<Map<string, AlbumZipJob>>(new Map())
  const prevAlbumThumbnailMapRef = useRef<Map<string, AlbumThumbnailJob>>(new Map())
  const prevFolderRenameMapRef = useRef<Map<string, FolderRenameJob>>(new Map())
  // Track IDs that the user has manually dismissed (so re-polls don't re-add them).
  const dismissedServerJobIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    dismissedServerJobIdsRef.current = loadDismissedServerJobIds()
  }, [])

  // ------ helpers ------

  /** Push internal list → React state. */
  const syncState = useCallback(() => {
    setUploads(
      jobsRef.current.map((j) => ({
        id: j.id,
        projectId: j.projectId,
        videoId: j.videoId,
        videoName: j.videoName,
        versionLabel: j.versionLabel,
        fileName: j.fileName,
        fileSize: j.fileSize,
        progress: j.progress,
        speed: j.speed,
        status: j.status,
        error: j.error,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
    )
  }, [])

  const patchJob = useCallback(
    (id: string, patch: Partial<InternalJob>) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (job) Object.assign(job, patch)
      syncState()
    },
    [syncState],
  )

  const removeJob = useCallback(
    (id: string) => {
      jobsRef.current = jobsRef.current.filter((j) => j.id !== id)
      activeIdsRef.current.delete(id)
      syncState()
    },
    [syncState],
  )

  // ------ queue runner ------

  const processNextRef = useRef<() => void>(() => {})

  const processNext = useCallback(() => {
    if (activeIdsRef.current.size >= MAX_CONCURRENT_UPLOADS) return
    const next = jobsRef.current.find((j) => j.status === 'queued')
    if (!next) return

    activeIdsRef.current.add(next.id)
    patchJob(next.id, { status: 'uploading' })

    const startTime = Date.now()
    next._lastLoaded = 0
    next._lastTime = startTime

    // -----------------------------------------------------------------------
    // Route to S3 (browser-direct) or TUS (through server).
    // isS3Mode() fetches the provider once from the server and caches it.
    // -----------------------------------------------------------------------
    ;(async () => {
      if (await isS3Mode()) {
        // ── S3 path: browser uploads directly to R2 ──────────────────────
        const abortController = new AbortController()
        next.s3AbortController = abortController
        const currentJob = next

        let uploadId: string | null = null
        let key: string | null = null

        const abortS3 = () => {
          abortController.abort()
          if (uploadId && key) {
            apiFetch('/api/uploads/s3/abort', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId: currentJob.videoId, uploadId, key }),
            }).catch(() => undefined)
          }
        }

        try {
          // Step 1: Presign
          const presignRes = await apiFetch('/api/uploads/s3/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              videoId: currentJob.videoId,
              fileSize: currentJob.file.size,
              fileName: currentJob.file.name,
              contentType: currentJob.file.type || 'video/mp4',
            }),
            signal: abortController.signal,
          })

          if (!presignRes.ok) {
            const errBody = await presignRes.json().catch(() => ({ error: 'Presign failed' }))
            throw new Error(errBody.error ?? 'Presign failed')
          }

          const { uploadId: uid, key: k, parts, partSize } = await presignRes.json()
          uploadId = uid
          key = k

          if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError')

          // Step 2: Upload all parts directly to R2
          const totalBytes = currentJob.file.size
          const completedParts: Array<{ partNumber: number; etag: string }> = new Array(parts.length)

          const MAX_CONCURRENT = 4
          let nextPartIdx = 0

          // Track the bytes the browser has sent into active upload requests for smooth progress,
          // but keep the displayed value below 100 until the multipart upload is fully completed.
          let totalSentBytes = 0
          let speedWindowStartTime = Date.now()
          let speedWindowStartBytes = 0
          let displaySpeedMBps = 0

          const patchDisplayedUploadState = () => {
            const progress = Math.floor((totalSentBytes / totalBytes) * 100)
            patchJob(currentJob.id, {
              progress: Math.min(progress, 99),
              speed: displaySpeedMBps > 0.05 ? Math.round(displaySpeedMBps * 10) / 10 : 0,
            })
          }

          async function uploadWorker() {
            while (nextPartIdx < parts.length) {
              const i = nextPartIdx++
              const part = parts[i]
              const start = i * partSize
              const end = Math.min(start + partSize, currentJob.file.size)
              const slice = currentJob.file.slice(start, end)
              const partBytes = end - start

              const etag = await new Promise<string>((resolve, reject) => {
                if (abortController.signal.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'))
                  return
                }
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

                  patchDisplayedUploadState()
                })
                xhr.addEventListener('load', () => {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    const trailingDelta = partBytes - lastLoaded
                    if (trailingDelta > 0) {
                      totalSentBytes = Math.min(totalSentBytes + trailingDelta, totalBytes)
                      patchDisplayedUploadState()
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
                abortController.signal.addEventListener('abort', onAbort, { once: true })
                xhr.addEventListener('loadend', () => abortController.signal.removeEventListener('abort', onAbort))
                xhr.send(slice)
              })

              completedParts[i] = { partNumber: part.partNumber, etag }
            }
          }

          await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, parts.length) }, uploadWorker))

          if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError')

          // Step 3: Complete
          const completeRes = await apiFetch('/api/uploads/s3/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: currentJob.videoId, uploadId, key, parts: completedParts }),
          })

          if (!completeRes.ok) {
            const errBody = await completeRes.json().catch(() => ({ error: 'Complete failed' }))
            throw new Error(errBody.error ?? 'Complete failed')
          }

          if (currentJob.cancelled) {
            activeIdsRef.current.delete(currentJob.id)
            processNextRef.current()
            return
          }

          patchJob(currentJob.id, { status: 'success', progress: 100, speed: 0, completedAt: Date.now() })
          activeIdsRef.current.delete(currentJob.id)
          currentJob.onComplete?.()
          try {
            window.dispatchEvent(new CustomEvent('upload-complete', { detail: { projectId: currentJob.projectId, videoId: currentJob.videoId } }))
          } catch {}
          const jobId = currentJob.id
          setTimeout(() => removeJob(jobId), 1_800_000)
          processNextRef.current()
        } catch (error: any) {
          if (abortController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            activeIdsRef.current.delete(currentJob.id)
            processNextRef.current()
            return
          }

          let errorMessage = error?.message ?? 'Upload failed'
          if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
            errorMessage = 'Network error — check your connection.'
          } else if (errorMessage.includes('401') || errorMessage.includes('403')) {
            errorMessage = 'Auth failed — please log in again.'
          }

          abortS3()

          try { await apiDelete(`/api/videos/${currentJob.videoId}`) } catch {
            try { await apiPost(`/api/videos/${currentJob.videoId}/cancel-upload`, {}) } catch {}
          }

          patchJob(currentJob.id, { status: 'error', error: errorMessage, speed: 0, completedAt: Date.now() })
          activeIdsRef.current.delete(currentJob.id)
          processNextRef.current()
        }

        return // S3 path done
      }

      // ── TUS path: upload through server ──────────────────────────────────
      const upload = new tus.Upload(next.file, {
        endpoint: `${window.location.origin}/api/uploads`,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        chunkSize: uploadChunkSizeBytes,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        metadata: {
          filename: next.file.name,
          filetype: next.file.type || 'video/mp4',
          videoId: next.videoId,
        },
        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject()
          const token = getAccessToken()
          if (token) {
            if (xhr?.setRequestHeader) {
              xhr.setRequestHeader('Authorization', `Bearer ${token}`)
            } else {
              req.setHeader('Authorization', `Bearer ${token}`)
            }
          }
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          if (next.cancelled) return
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100)
          const now = Date.now()
          const job = jobsRef.current.find((j) => j.id === next.id)
          if (!job) return
          const timeDiff = (now - job._lastTime) / 1000
          const bytesDiff = bytesUploaded - job._lastLoaded
          if (timeDiff > 0.5) {
            const speedMBps = bytesDiff / timeDiff / (1024 * 1024)
            const stableSpeed = speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : 0
            patchJob(next.id, { progress: percentage, speed: stableSpeed, _lastLoaded: bytesUploaded, _lastTime: now })
          } else {
            patchJob(next.id, { progress: percentage })
          }
        },
        onSuccess: () => {
          if (next.cancelled) {
            activeIdsRef.current.delete(next.id)
            processNextRef.current()
            return
          }
          clearFileContext(next.file)
          clearUploadMetadata(next.file)
          clearTUSFingerprint(next.file)
          patchJob(next.id, { status: 'success', progress: 100, speed: 0, completedAt: Date.now() })
          activeIdsRef.current.delete(next.id)

          // Notify listeners (project pages, etc.)
          next.onComplete?.()
          try {
            window.dispatchEvent(
              new CustomEvent('upload-complete', { detail: { projectId: next.projectId, videoId: next.videoId } }),
            )
          } catch {}

          // Auto-remove successful jobs after 30 minutes.
          const jobId = next.id
          setTimeout(() => removeJob(jobId), 1_800_000)

          processNextRef.current()
        },
        onError: async (error) => {
          if (next.cancelled) {
            activeIdsRef.current.delete(next.id)
            processNextRef.current()
            return
          }

          let errorMessage = error.message || 'Upload failed'
          if (error.message?.includes('NetworkError') || error.message?.includes('Failed to fetch')) {
            errorMessage = 'Network error — check your connection.'
          } else if (error.message?.includes('413')) {
            errorMessage = 'File too large.'
          } else if (error.message?.includes('401') || error.message?.includes('403')) {
            errorMessage = 'Auth failed — please log in again.'
          }

          // Clean up server-side record.
          if (next.videoId) {
            try {
              await apiDelete(`/api/videos/${next.videoId}`)
            } catch {
              try {
                await apiPost(`/api/videos/${next.videoId}/cancel-upload`, {})
              } catch {}
            }
            clearUploadMetadata(next.file)
            clearTUSFingerprint(next.file)
          }

          patchJob(next.id, { status: 'error', error: errorMessage, speed: 0, completedAt: Date.now() })
          activeIdsRef.current.delete(next.id)
          processNextRef.current()
        },
      })

      // Attempt resume.
      upload
        .findPreviousUploads()
        .then((prev) => {
          if (prev.length > 0) upload.resumeFromPreviousUpload(prev[0])
          upload.start()
        })
        .catch(() => upload.start())

      next.tusUpload = upload
    })()
  }, [patchJob, removeJob, uploadChunkSizeBytes])

  // Keep ref in sync so callbacks can call processNext without stale closure.
  useEffect(() => {
    processNextRef.current = processNext
  }, [processNext])

  // ------ beforeunload guard ------

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasActive = jobsRef.current.some(
        (j) => j.status === 'queued' || j.status === 'uploading' || j.status === 'paused',
      )
      if (hasActive) {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // ------ poll server-side processing jobs ------

  const [dropdownOpen, setDropdownOpen] = useState(false)

  useEffect(() => {
    let active = true

    async function poll() {
      try {
        const res = await apiFetch('/api/running-jobs')
        if (res.ok && active) {
          const data = await res.json()
          const now = Date.now()
          const newCompleted: CompletedServerJob[] = []

          // --- Processing jobs ---
          if (Array.isArray(data.jobs)) {
            const incoming = data.jobs as ProcessingJob[]
            const incomingIds = new Set(incoming.map((j: ProcessingJob) => j.id))

            // Detect jobs that disappeared (completed)
            for (const prevId of prevProcessingIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('processing', prevId))) {
                const prev = prevProcessingMapRef.current.get(prevId)
                if (prev) {
                  newCompleted.push({
                    id: prevId,
                    type: 'processing',
                    label: prev.videoName,
                    sublabel: prev.projectName,
                    projectId: prev.projectId,
                    completedAt: now,
                  })
                }
              }
            }

            prevProcessingIdsRef.current = incomingIds
            prevProcessingMapRef.current = new Map(incoming.map((j: ProcessingJob) => [j.id, j]))
            setProcessingJobs(incoming)
          }

          if (Array.isArray(data.completedProcessingJobs) && data.completedProcessingJobs.length > 0) {
            newCompleted.push(
              ...(data.completedProcessingJobs as CompletedServerJob[]).filter(
                (job) => !dismissedServerJobIdsRef.current.has(getCompletedServerJobKey(job)),
              ),
            )
          }

          // Errored video processing jobs from API
          if (Array.isArray(data.erroredProcessingJobs) && data.erroredProcessingJobs.length > 0) {
            newCompleted.push(
              ...(data.erroredProcessingJobs as CompletedServerJob[]).filter(
                (job) => !dismissedServerJobIdsRef.current.has(getCompletedServerJobKey(job)),
              ),
            )
          }

          // --- Album ZIP jobs ---
          if (Array.isArray(data.albumZipJobs)) {
            const incoming = data.albumZipJobs as AlbumZipJob[]
            const incomingIds = new Set(incoming.map((j: AlbumZipJob) => j.id))

            for (const prevId of prevAlbumZipIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('albumZip', prevId))) {
                const prev = prevAlbumZipMapRef.current.get(prevId)
                if (prev) {
                  const variantLabel = prev.variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'
                  newCompleted.push({
                    id: prevId,
                    type: 'albumZip',
                    label: prev.albumName,
                    sublabel: `${prev.projectName} · ${variantLabel}`,
                    projectId: prev.projectId,
                    completedAt: now,
                  })
                }
              }
            }

            prevAlbumZipIdsRef.current = incomingIds
            prevAlbumZipMapRef.current = new Map(incoming.map((j: AlbumZipJob) => [j.id, j]))
            setAlbumZipJobs(incoming)
          }

          // --- Album thumbnail jobs ---
          if (data.albumThumbnailJobs?.active != null || data.albumThumbnailJobs?.completed != null) {
            const incoming = (data.albumThumbnailJobs.active ?? []) as AlbumThumbnailJob[]
            const incomingIds = new Set(incoming.map((j: AlbumThumbnailJob) => j.id))

            for (const prevId of prevAlbumThumbnailIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('albumThumbnail', prevId))) {
                const prev = prevAlbumThumbnailMapRef.current.get(prevId)
                if (prev) {
                  newCompleted.push({
                    id: prevId,
                    type: 'albumThumbnail',
                    label: prev.albumName,
                    sublabel: `${prev.projectName} · Album thumbnails complete`,
                    projectId: prev.projectId,
                    completedAt: now,
                  })
                }
              }
            }

            for (const j of (data.albumThumbnailJobs.completed ?? []) as any[]) {
              const key = getCompletedServerJobKeyByParts('albumThumbnail', j.id)
              if (!dismissedServerJobIdsRef.current.has(key)) {
                newCompleted.push({ ...j, type: 'albumThumbnail' } as CompletedServerJob)
              }
            }

            prevAlbumThumbnailIdsRef.current = incomingIds
            prevAlbumThumbnailMapRef.current = new Map(incoming.map((j: AlbumThumbnailJob) => [j.id, j]))
            setAlbumThumbnailJobs(incoming)
          }

          // --- Folder rename jobs ---
          if (data.folderRenameJobs?.active != null || data.folderRenameJobs?.completed != null) {
            const incoming = (data.folderRenameJobs.active ?? []) as FolderRenameJob[]
            const incomingIds = new Set(incoming.map((j: FolderRenameJob) => j.id))

            for (const prevId of prevFolderRenameIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('folderRename', prevId))) {
                const prev = prevFolderRenameMapRef.current.get(prevId)
                if (prev) {
                  newCompleted.push({
                    id: prevId,
                    type: 'folderRename',
                    label: prev.entityName,
                    sublabel: prev.entityType === 'PROJECT' ? 'Project rename complete'
                      : prev.entityType === 'CLIENT' ? 'Client rename complete'
                      : prev.entityType === 'VIDEO_GROUP' ? 'Video rename complete'
                      : 'Album rename complete',
                    projectId: prev.entityType === 'PROJECT' ? prev.entityId : '',
                    completedAt: now,
                  })
                }
              }
            }

            // Also surface any server-reported completed/errored folder rename jobs
            for (const j of (data.folderRenameJobs.completed ?? []) as any[]) {
              const key = getCompletedServerJobKeyByParts('folderRename', j.id)
              if (!dismissedServerJobIdsRef.current.has(key)) {
                newCompleted.push({ ...j, type: 'folderRename' } as CompletedServerJob)
              }
            }

            prevFolderRenameIdsRef.current = incomingIds
            prevFolderRenameMapRef.current = new Map(incoming.map((j: FolderRenameJob) => [j.id, j]))
            setFolderRenameJobs(incoming)
          }

          // Merge new completions and purge stale (>30 min, but keep errors)
          if (newCompleted.length > 0) {
            setCompletedServerJobs((prev) => {
              const merged = new Map<string, CompletedServerJob>()

              for (const job of prev) {
                // Keep error jobs indefinitely; only auto-purge successful completions after 30 min
                if (job.error || now - job.completedAt < 1_800_000) {
                  merged.set(getCompletedServerJobKey(job), job)
                }
              }

              for (const job of newCompleted) {
                const jobKey = getCompletedServerJobKey(job)
                if (dismissedServerJobIdsRef.current.has(jobKey)) continue
                const existing = merged.get(jobKey)
                // Prefer entries with error info from the API over disappearance-detected ones
                if (!existing || existing.completedAt < job.completedAt || (job.error && !existing.error)) {
                  merged.set(jobKey, job)
                }
              }

              return Array.from(merged.values()).sort((a, b) => b.completedAt - a.completedAt)
            })
          } else {
            // Purge stale entries even when no new completions (keep errors)
            setCompletedServerJobs((prev) => {
              const filtered = prev.filter((j) => j.error || now - j.completedAt < 1_800_000)
              return filtered.length !== prev.length ? filtered : prev
            })
          }
        }
      } catch {
        // ignore transient errors
      }
    }

    poll()
    const interval = setInterval(poll, dropdownOpen ? 5_000 : 10_000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [dropdownOpen])

  // ------ public API ------

  const addUpload = useCallback(
    (config: StartUploadConfig): string => {
      const id = `upload-${Date.now()}-${crypto.randomUUID()}`

      storeUploadMetadata(config.file, {
        videoId: config.videoId,
        projectId: config.projectId,
        versionLabel: config.versionLabel || '',
        targetName: config.videoName,
      })

      const job: InternalJob = {
        id,
        projectId: config.projectId,
        videoId: config.videoId,
        videoName: config.videoName,
        versionLabel: config.versionLabel || null,
        fileName: config.file.name,
        fileSize: config.file.size,
        file: config.file,
        progress: 0,
        speed: 0,
        status: 'queued',
        error: null,
        createdAt: Date.now(),
        completedAt: null,
        tusUpload: null,
        onComplete: config.onComplete,
        cancelled: false,
        _lastLoaded: 0,
        _lastTime: 0,
      }

      jobsRef.current = [...jobsRef.current, job]
      syncState()

      // Kick the queue.
      // Use setTimeout(0) so the state update propagates before processNext reads the list.
      setTimeout(() => processNextRef.current(), 0)

      return id
    },
    [syncState],
  )

  const cancelUpload = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job) return

       job.cancelled = true

      if (job.s3AbortController) {
        job.s3AbortController.abort()
      } else if (job.tusUpload) {
        try {
          job.tusUpload.abort(true)
        } catch {}
      }

      if (job.videoId) {
        apiDelete(`/api/videos/${job.videoId}`).catch(() => {
          apiPost(`/api/videos/${job.videoId}/cancel-upload`, {}).catch(() => {})
        })
      }

      clearUploadMetadata(job.file)
      clearTUSFingerprint(job.file)
      clearFileContext(job.file)

      removeJob(id)
      processNextRef.current()
    },
    [removeJob],
  )

  useEffect(() => {
    const handleExternalVideoDelete = (event: Event) => {
      const videoId = (event as CustomEvent<{ videoId?: string }>).detail?.videoId
      if (!videoId) return

      const job = jobsRef.current.find((j) => j.videoId === videoId)
      if (!job) return

      job.cancelled = true
      if (job.s3AbortController) {
        job.s3AbortController.abort()
      } else if (job.tusUpload) {
        try {
          job.tusUpload.abort(true)
        } catch {}
      }

      clearUploadMetadata(job.file)
      clearTUSFingerprint(job.file)
      clearFileContext(job.file)

      removeJob(job.id)
      processNextRef.current()
    }

    window.addEventListener('video-deleted', handleExternalVideoDelete as EventListener)
    return () => window.removeEventListener('video-deleted', handleExternalVideoDelete as EventListener)
  }, [removeJob])

  const pauseUpload = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job || job.status !== 'uploading') return
      // S3 multipart uploads cannot be paused (no resume support in this implementation)
      // S3 multipart uploads cannot be paused in this implementation
      if (job.s3AbortController) return
      if (job.tusUpload) {
        try {
          job.tusUpload.abort()
        } catch {}
      }
      patchJob(id, { status: 'paused', speed: 0 })
      activeIdsRef.current.delete(id)
      processNextRef.current()
    },
    [patchJob],
  )

  const resumeUpload = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job || job.status !== 'paused') return
      // Re-queue so processNext picks it up.
      patchJob(id, { status: 'queued' })
      setTimeout(() => processNextRef.current(), 0)
    },
    [patchJob],
  )

  const dismissUpload = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job || (job.status !== 'success' && job.status !== 'error')) return
      removeJob(id)
    },
    [removeJob],
  )

  const dismissCompletedJob = useCallback(
    (jobKey: string) => {
      dismissedServerJobIdsRef.current.add(jobKey)
      persistDismissedServerJobIds(dismissedServerJobIdsRef.current)
      setCompletedServerJobs((prev) => prev.filter((j) => getCompletedServerJobKey(j) !== jobKey))
    },
    [],
  )

  const clearRunningJob = useCallback(
    async (target: ClearRunningJobTarget) => {
      await apiPost('/api/running-jobs', target)

      const jobKey = getCompletedServerJobKeyByParts(target.type, target.id)
      dismissedServerJobIdsRef.current.add(jobKey)
      persistDismissedServerJobIds(dismissedServerJobIdsRef.current)
      setCompletedServerJobs((prev) => prev.filter((job) => getCompletedServerJobKey(job) !== jobKey))

      if (target.type === 'processing') {
        setProcessingJobs((prev) => prev.filter((job) => job.id !== target.id))
        return
      }

      if (target.type === 'albumZip') {
        setAlbumZipJobs((prev) => prev.filter((job) => job.id !== target.id))
        return
      }

      if (target.type === 'albumThumbnail') {
        setAlbumThumbnailJobs((prev) => prev.filter((job) => job.id !== target.id))
        return
      }

      setFolderRenameJobs((prev) => prev.filter((job) => job.id !== target.id))
    },
    [],
  )

  // ------ derived ------

  const totalActiveCount =
    uploads.filter((u) => u.status === 'queued' || u.status === 'uploading' || u.status === 'paused').length +
    processingJobs.length +
    albumZipJobs.length +
    albumThumbnailJobs.length +
    folderRenameJobs.length

  const actionsValue = useMemo<UploadManagerActionsContextType>(() => ({
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    clearRunningJob,
    setDropdownOpen,
  }), [addUpload, cancelUpload, clearRunningJob, dismissCompletedJob, dismissUpload, pauseUpload, resumeUpload])

  const contextValue = useMemo<UploadManagerContextType>(() => ({
    uploads,
    processingJobs,
    albumZipJobs,
    albumThumbnailJobs,
    folderRenameJobs,
    completedServerJobs,
    totalActiveCount,
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    clearRunningJob,
    setDropdownOpen,
  }), [
    uploads,
    processingJobs,
    albumZipJobs,
    albumThumbnailJobs,
    folderRenameJobs,
    completedServerJobs,
    totalActiveCount,
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    clearRunningJob,
  ])

  return (
    <UploadManagerActionsContext.Provider value={actionsValue}>
      <UploadManagerContext.Provider value={contextValue}>
        {children}
      </UploadManagerContext.Provider>
    </UploadManagerActionsContext.Provider>
  )
}
