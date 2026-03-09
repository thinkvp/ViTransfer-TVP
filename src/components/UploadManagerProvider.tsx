'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { getAccessToken } from '@/lib/token-store'
import { apiFetch, apiDelete, apiPost } from '@/lib/api-client'
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
  /** Badge count: queued + uploading + paused + processing. */
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
  /** Notify the provider when the Running Jobs dropdown opens/closes (adjusts poll rate). */
  setDropdownOpen: (open: boolean) => void
}

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

export function useUploadManager() {
  const ctx = useContext(UploadManagerContext)
  if (!ctx) throw new Error('useUploadManager must be used within UploadManagerProvider')
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

export function UploadManagerProvider({ children }: { children: React.ReactNode }) {
  // Internal mutable list — avoids stale-closure issues in TUS callbacks.
  const jobsRef = useRef<InternalJob[]>([])
  const activeIdRef = useRef<string | null>(null)

  // React state for consumers.
  const [uploads, setUploads] = useState<UploadJob[]>([])
  const [processingJobs, setProcessingJobs] = useState<ProcessingJob[]>([])

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
      if (activeIdRef.current === id) activeIdRef.current = null
      syncState()
    },
    [syncState],
  )

  // ------ queue runner ------

  const processNextRef = useRef<() => void>(() => {})

  const processNext = useCallback(() => {
    if (activeIdRef.current) return
    const next = jobsRef.current.find((j) => j.status === 'queued')
    if (!next) return

    activeIdRef.current = next.id
    patchJob(next.id, { status: 'uploading' })

    const startTime = Date.now()
    next._lastLoaded = 0
    next._lastTime = startTime

    const upload = new tus.Upload(next.file, {
      endpoint: `${window.location.origin}/api/uploads`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      chunkSize: 50 * 1024 * 1024,
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
          activeIdRef.current = null
          processNextRef.current()
          return
        }
        clearFileContext(next.file)
        clearUploadMetadata(next.file)
        clearTUSFingerprint(next.file)
        patchJob(next.id, { status: 'success', progress: 100, speed: 0 })
        activeIdRef.current = null

        // Notify listeners (project pages, etc.)
        next.onComplete?.()
        try {
          window.dispatchEvent(
            new CustomEvent('upload-complete', { detail: { projectId: next.projectId, videoId: next.videoId } }),
          )
        } catch {}

        // Auto-remove successful jobs after 10 minutes.
        const jobId = next.id
        setTimeout(() => removeJob(jobId), 600_000)

        processNextRef.current()
      },
      onError: async (error) => {
        if (next.cancelled) {
          activeIdRef.current = null
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

        patchJob(next.id, { status: 'error', error: errorMessage, speed: 0 })
        activeIdRef.current = null
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
  }, [patchJob, removeJob])

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
          if (Array.isArray(data.jobs)) setProcessingJobs(data.jobs)
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
      activeIdRef.current = null
      // Don't processNext — paused job blocks the slot intentionally.
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

  // ------ derived ------

  const totalActiveCount =
    uploads.filter((u) => u.status === 'queued' || u.status === 'uploading' || u.status === 'paused').length +
    processingJobs.length

  return (
    <UploadManagerContext.Provider
      value={{
        uploads,
        processingJobs,
        totalActiveCount,
        addUpload,
        cancelUpload,
        pauseUpload,
        resumeUpload,
        dismissUpload,
        setDropdownOpen,
      }}
    >
      {children}
    </UploadManagerContext.Provider>
  )
}
