'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { getAccessToken } from '@/lib/token-store'
import { apiFetch, apiDelete, apiPost } from '@/lib/api-client'
import { useTransferTuning } from '@/lib/transfer-tuning-client'
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

/** Background Dropbox upload job (polled from server). */
export type DropboxUploadJob = {
  id: string
  projectId: string
  projectName: string
  videoName: string
  versionLabel: string | null
  status: string // PENDING | UPLOADING
  progress: number
  fileSizeBytes: number
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

/** Album ZIP Dropbox upload job (polled from server DB). */
export type AlbumZipDropboxJob = {
  id: string
  albumId: string
  albumName: string
  projectId: string
  projectName: string
  variant: 'full' | 'social'
  status: string // PENDING | UPLOADING
  progress: number
  fileSizeBytes: number
}

/** A server-side job that has recently completed (kept for 30 min). */
export type CompletedServerJob = {
  id: string
  type: 'processing' | 'dropbox' | 'albumZip' | 'albumZipDropbox'
  label: string
  sublabel: string
  projectId: string
  completedAt: number
  /** True when the job finished with an error (not a successful completion). */
  error?: boolean
}

function getCompletedServerJobKey(job: Pick<CompletedServerJob, 'id' | 'type'>): string {
  return `${job.type}:${job.id}`
}

function getCompletedServerJobKeyByParts(type: CompletedServerJob['type'], id: string): string {
  return `${type}:${id}`
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
  /** Background Dropbox upload jobs (polled). */
  dropboxJobs: DropboxUploadJob[]
  /** Album ZIP generation jobs (polled from queue). */
  albumZipJobs: AlbumZipJob[]
  /** Album ZIP Dropbox upload jobs (polled). */
  albumZipDropboxJobs: AlbumZipDropboxJob[]
  /** Recently completed server-side jobs (kept for 30 min). */
  completedServerJobs: CompletedServerJob[]
  /** Badge count: queued + uploading + paused + processing + dropbox + album zips. */
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
  /** Notify the provider when the Running Jobs dropdown opens/closes (adjusts poll rate). */
  setDropdownOpen: (open: boolean) => void
}

type UploadManagerActionsContextType = Pick<
  UploadManagerContextType,
  'addUpload' | 'cancelUpload' | 'pauseUpload' | 'resumeUpload' | 'dismissUpload' | 'dismissCompletedJob' | 'setDropdownOpen'
>

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type InternalJob = UploadJob & {
  file: File
  tusUpload: tus.Upload | null
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
  const [dropboxJobs, setDropboxJobs] = useState<DropboxUploadJob[]>([])
  const [albumZipJobs, setAlbumZipJobs] = useState<AlbumZipJob[]>([])
  const [albumZipDropboxJobs, setAlbumZipDropboxJobs] = useState<AlbumZipDropboxJob[]>([])
  const [completedServerJobs, setCompletedServerJobs] = useState<CompletedServerJob[]>([])

  // Track previously-seen job IDs so we can detect completions.
  const prevProcessingIdsRef = useRef<Set<string>>(new Set())
  const prevDropboxIdsRef = useRef<Set<string>>(new Set())
  const prevAlbumZipIdsRef = useRef<Set<string>>(new Set())
  const prevAlbumZipDropboxIdsRef = useRef<Set<string>>(new Set())
  // Map id → job metadata for building completion entries.
  const prevProcessingMapRef = useRef<Map<string, ProcessingJob>>(new Map())
  const prevDropboxMapRef = useRef<Map<string, DropboxUploadJob>>(new Map())
  const prevAlbumZipMapRef = useRef<Map<string, AlbumZipJob>>(new Map())
  const prevAlbumZipDropboxMapRef = useRef<Map<string, AlbumZipDropboxJob>>(new Map())
  // Track IDs that the user has manually dismissed (so re-polls don't re-add them).
  const dismissedServerJobIdsRef = useRef<Set<string>>(new Set())

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

          // --- Dropbox upload jobs ---
          if (Array.isArray(data.dropboxJobs)) {
            const incoming = data.dropboxJobs as DropboxUploadJob[]
            const incomingIds = new Set(incoming.map((j: DropboxUploadJob) => j.id))

            for (const prevId of prevDropboxIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('dropbox', prevId))) {
                const prev = prevDropboxMapRef.current.get(prevId)
                if (prev) {
                  newCompleted.push({
                    id: prevId,
                    type: 'dropbox',
                    label: prev.videoName,
                    sublabel: prev.projectName,
                    projectId: prev.projectId,
                    completedAt: now,
                  })
                }
              }
            }

            prevDropboxIdsRef.current = incomingIds
            prevDropboxMapRef.current = new Map(incoming.map((j: DropboxUploadJob) => [j.id, j]))
            setDropboxJobs(incoming)
          }

          if (Array.isArray(data.completedProcessingJobs) && data.completedProcessingJobs.length > 0) {
            newCompleted.push(...(data.completedProcessingJobs as CompletedServerJob[]))
          }

          if (Array.isArray(data.completedDropboxJobs) && data.completedDropboxJobs.length > 0) {
            newCompleted.push(...(data.completedDropboxJobs as CompletedServerJob[]))
          }

          // Errored album ZIP Dropbox uploads from API
          if (Array.isArray(data.erroredAlbumZipDropboxJobs) && data.erroredAlbumZipDropboxJobs.length > 0) {
            newCompleted.push(...(data.erroredAlbumZipDropboxJobs as CompletedServerJob[]))
          }

          // Errored video processing jobs from API
          if (Array.isArray(data.erroredProcessingJobs) && data.erroredProcessingJobs.length > 0) {
            newCompleted.push(...(data.erroredProcessingJobs as CompletedServerJob[]))
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

          // --- Album ZIP Dropbox upload jobs ---
          if (Array.isArray(data.albumZipDropboxJobs)) {
            const incoming = data.albumZipDropboxJobs as AlbumZipDropboxJob[]
            const incomingIds = new Set(incoming.map((j: AlbumZipDropboxJob) => j.id))

            for (const prevId of prevAlbumZipDropboxIdsRef.current) {
              if (!incomingIds.has(prevId) && !dismissedServerJobIdsRef.current.has(getCompletedServerJobKeyByParts('albumZipDropbox', prevId))) {
                const prev = prevAlbumZipDropboxMapRef.current.get(prevId)
                if (prev) {
                  const variantLabel = prev.variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'
                  newCompleted.push({
                    id: prevId,
                    type: 'albumZipDropbox',
                    label: prev.albumName,
                    sublabel: `${prev.projectName} · ${variantLabel}`,
                    projectId: prev.projectId,
                    completedAt: now,
                  })
                }
              }
            }

            prevAlbumZipDropboxIdsRef.current = incomingIds
            prevAlbumZipDropboxMapRef.current = new Map(incoming.map((j: AlbumZipDropboxJob) => [j.id, j]))
            setAlbumZipDropboxJobs(incoming)
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
      const id = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`

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

      if (job.tusUpload) {
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
      if (job.tusUpload) {
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
      setCompletedServerJobs((prev) => prev.filter((j) => getCompletedServerJobKey(j) !== jobKey))
    },
    [],
  )

  // ------ derived ------

  const totalActiveCount =
    uploads.filter((u) => u.status === 'queued' || u.status === 'uploading' || u.status === 'paused').length +
    processingJobs.length +
    dropboxJobs.length +
    albumZipJobs.length +
    albumZipDropboxJobs.length

  const actionsValue = useMemo<UploadManagerActionsContextType>(() => ({
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    setDropdownOpen,
  }), [addUpload, cancelUpload, dismissCompletedJob, dismissUpload, pauseUpload, resumeUpload])

  const contextValue = useMemo<UploadManagerContextType>(() => ({
    uploads,
    processingJobs,
    dropboxJobs,
    albumZipJobs,
    albumZipDropboxJobs,
    completedServerJobs,
    totalActiveCount,
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    setDropdownOpen,
  }), [
    uploads,
    processingJobs,
    dropboxJobs,
    albumZipJobs,
    albumZipDropboxJobs,
    completedServerJobs,
    totalActiveCount,
    addUpload,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
  ])

  return (
    <UploadManagerActionsContext.Provider value={actionsValue}>
      <UploadManagerContext.Provider value={contextValue}>
        {children}
      </UploadManagerContext.Provider>
    </UploadManagerActionsContext.Provider>
  )
}
