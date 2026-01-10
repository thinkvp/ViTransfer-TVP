import { useState, useRef, useCallback, useEffect } from 'react'
import * as tus from 'tus-js-client'
import { apiPost } from '@/lib/api-client'
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/token-store'
import {
  ensureFreshUploadOnContextChange,
  clearFileContext,
  clearTUSFingerprint,
} from '@/lib/tus-context'
import {
  clearAlbumPhotoUploadMetadata,
  getAlbumPhotoUploadMetadata,
  storeAlbumPhotoUploadMetadata,
} from '@/lib/tus-album-photo-metadata'

export interface QueuedAlbumPhotoUpload {
  id: string
  file: File
  photoId: string | null
  albumId: string

  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null

  tusUpload: tus.Upload | null

  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

interface UseAlbumPhotoUploadQueueOptions {
  albumId: string
  maxConcurrent?: number
  onUploadComplete?: () => void
}

export function useAlbumPhotoUploadQueue({
  albumId,
  maxConcurrent = 3,
  onUploadComplete,
}: UseAlbumPhotoUploadQueueOptions) {
  const [queue, setQueue] = useState<QueuedAlbumPhotoUpload[]>([])
  const uploadRefsMap = useRef<Map<string, tus.Upload>>(new Map())
  const photoIdsMap = useRef<Map<string, string>>(new Map())
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null)
  const refreshAttemptsRef = useRef<Map<string, number>>(new Map())
  const queueRef = useRef(queue)

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  const attemptRefresh = useCallback(async (): Promise<boolean> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current

    const refreshToken = getRefreshToken()
    if (!refreshToken) return false

    refreshInFlightRef.current = (async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshToken}` },
        })

        if (!response.ok) {
          clearTokens()
          return false
        }

        const data = await response.json()
        if (data?.tokens?.accessToken && data?.tokens?.refreshToken) {
          setTokens({
            accessToken: data.tokens.accessToken,
            refreshToken: data.tokens.refreshToken,
          })
          return true
        }

        clearTokens()
        return false
      } catch {
        clearTokens()
        return false
      } finally {
        refreshInFlightRef.current = null
      }
    })()

    return refreshInFlightRef.current
  }, [])

  const generateUploadId = useCallback((): string => {
    const cryptoObj: Crypto | undefined = (globalThis as any).crypto
    if (cryptoObj?.randomUUID) {
      return `upload-${Date.now()}-${cryptoObj.randomUUID()}`
    }

    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16)
      cryptoObj.getRandomValues(bytes)
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return `upload-${Date.now()}-${hex}`
    }

    return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }, [])

  const addToQueue = useCallback(
    (file: File): string => {
      const uploadId = generateUploadId()

      const newUpload: QueuedAlbumPhotoUpload = {
        id: uploadId,
        file,
        photoId: null,
        albumId,
        status: 'queued',
        progress: 0,
        uploadSpeed: 0,
        error: null,
        tusUpload: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
      }

      setQueue((prev) => [...prev, newUpload])
      return uploadId
    },
    [albumId, generateUploadId]
  )

  const startUpload = useCallback(
    async (uploadId: string) => {
      const upload = queueRef.current.find((u) => u.id === uploadId)
      if (!upload || upload.status === 'uploading') return

      try {
        ensureFreshUploadOnContextChange(upload.file, `album:${albumId}`)

        const existingMetadata = getAlbumPhotoUploadMetadata(upload.file)
        const canResumeExisting =
          existingMetadata?.albumId === albumId &&
          typeof existingMetadata?.photoId === 'string' &&
          existingMetadata.photoId.length > 0

        setQueue((prev) =>
          prev.map((u) =>
            u.id === uploadId ? { ...u, status: 'uploading' as const, startedAt: Date.now(), error: null } : u
          )
        )

        let photoId: string
        if (canResumeExisting) {
          photoId = existingMetadata!.photoId
          photoIdsMap.current.set(uploadId, photoId)
          storeAlbumPhotoUploadMetadata(upload.file, { albumId, photoId })
        } else {
          const response = await apiPost(`/api/albums/${albumId}/photos`, {
            fileName: upload.file.name,
            fileSize: upload.file.size,
          })

          photoId = response.photoId
          photoIdsMap.current.set(uploadId, photoId)
          storeAlbumPhotoUploadMetadata(upload.file, { albumId, photoId })
        }

        setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, photoId } : u)))

        const startTime = Date.now()
        let lastLoaded = 0
        let lastTime = startTime

        const tusUpload = new tus.Upload(upload.file, {
          endpoint: `${window.location.origin}/api/uploads`,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          metadata: {
            filename: upload.file.name,
            filetype: upload.file.type || 'application/octet-stream',
            photoId,
          },
          chunkSize: 10 * 1024 * 1024,
          storeFingerprintForResuming: true,
          removeFingerprintOnSuccess: true,

          onProgress: (bytesUploaded, bytesTotal) => {
            const percentage = Math.round((bytesUploaded / bytesTotal) * 100)

            const now = Date.now()
            const timeDiff = (now - lastTime) / 1000
            const bytesDiff = bytesUploaded - lastLoaded

            let speedMBps = 0
            if (timeDiff > 0.5) {
              speedMBps = bytesDiff / timeDiff / (1024 * 1024)
              lastLoaded = bytesUploaded
              lastTime = now
            }

            setQueue((prev) =>
              prev.map((u) =>
                u.id === uploadId
                  ? {
                      ...u,
                      progress: percentage,
                      uploadSpeed: speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : u.uploadSpeed,
                    }
                  : u
              )
            )
          },

          onSuccess: () => {
            setQueue((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, status: 'completed' as const, progress: 100, completedAt: Date.now() } : u
              )
            )

            uploadRefsMap.current.delete(uploadId)
            photoIdsMap.current.delete(uploadId)
            refreshAttemptsRef.current.delete(uploadId)

            clearFileContext(upload.file)
            clearAlbumPhotoUploadMetadata(upload.file)
            clearTUSFingerprint(upload.file)

            onUploadComplete?.()
          },

          onError: async (error) => {
            const statusCode = (error as any)?.originalResponse?.getStatus?.()
            const currentAttempts = refreshAttemptsRef.current.get(uploadId) ?? 0

            if ((statusCode === 401 || statusCode === 403) && currentAttempts < 2) {
              refreshAttemptsRef.current.set(uploadId, currentAttempts + 1)
              const refreshed = await attemptRefresh()
              if (refreshed) {
                tusUpload.start()
                return
              }
            }

            let errorMessage = error instanceof Error ? error.message : 'Upload failed'

            setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'error' as const, error: errorMessage } : u)))

            uploadRefsMap.current.delete(uploadId)
            refreshAttemptsRef.current.delete(uploadId)
          },

          onBeforeRequest: (req) => {
            const xhr = req.getUnderlyingObject()
            xhr.withCredentials = true

            const token = getAccessToken()
            if (token) {
              if (xhr?.setRequestHeader) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
              else req.setHeader('Authorization', `Bearer ${token}`)
            }
          },
        })

        const previousUploads = await tusUpload.findPreviousUploads()
        if (previousUploads.length > 0) {
          tusUpload.resumeFromPreviousUpload(previousUploads[0])
        } else if (canResumeExisting) {
          clearAlbumPhotoUploadMetadata(upload.file)
          clearTUSFingerprint(upload.file)
        }

        uploadRefsMap.current.set(uploadId, tusUpload)
        tusUpload.start()
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Upload failed'
        setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'error' as const, error: errorMessage } : u)))
        refreshAttemptsRef.current.delete(uploadId)
      }
    },
    [albumId, attemptRefresh, onUploadComplete]
  )

  useEffect(() => {
    const currentUploading = queue.filter((u) => u.status === 'uploading').length
    const queuedUploads = queue.filter((u) => u.status === 'queued')

    if (currentUploading < maxConcurrent && queuedUploads.length > 0) {
      const slotsAvailable = maxConcurrent - currentUploading
      const uploadsToStart = queuedUploads.slice(0, slotsAvailable)
      uploadsToStart.forEach((u) => startUpload(u.id))
    }
  }, [queue, maxConcurrent, startUpload])

  useEffect(() => {
    const hasActiveUploads = queue.some((u) => u.status === 'uploading' || u.status === 'queued' || u.status === 'paused')
    if (!hasActiveUploads) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [queue])

  const pauseUpload = useCallback((uploadId: string) => {
    const tusUpload = uploadRefsMap.current.get(uploadId)
    if (!tusUpload) return
    tusUpload.abort()
    setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'paused' as const } : u)))
  }, [])

  const resumeUpload = useCallback(
    (uploadId: string) => {
      const tusUpload = uploadRefsMap.current.get(uploadId)
      if (tusUpload) {
        tusUpload.start()
        setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'uploading' as const } : u)))
        return
      }

      // If we lost the reference (refresh), just restart the upload flow
      setQueue((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'queued' as const } : u)))
      setTimeout(() => startUpload(uploadId), 100)
    },
    [startUpload]
  )

  const cancelUpload = useCallback(
    async (uploadId: string) => {
      const tusUpload = uploadRefsMap.current.get(uploadId)
      if (tusUpload) tusUpload.abort(true)

      uploadRefsMap.current.delete(uploadId)
      photoIdsMap.current.delete(uploadId)
      refreshAttemptsRef.current.delete(uploadId)

      setQueue((prev) => prev.filter((u) => u.id !== uploadId))

      const upload = queueRef.current.find((u) => u.id === uploadId)
      if (upload) {
        clearAlbumPhotoUploadMetadata(upload.file)
        clearTUSFingerprint(upload.file)
        clearFileContext(upload.file)
      }
    },
    [queueRef]
  )

  const removeCompleted = useCallback((uploadId: string) => {
    setQueue((prev) => prev.filter((u) => u.id !== uploadId))
  }, [])

  const clearCompleted = useCallback(() => {
    setQueue((prev) => prev.filter((u) => u.status !== 'completed'))
  }, [])

  const retryUpload = useCallback(
    (uploadId: string) => {
      setQueue((prev) =>
        prev.map((u) =>
          u.id === uploadId
            ? { ...u, status: 'queued' as const, error: null, progress: 0, uploadSpeed: 0 }
            : u
        )
      )

      setTimeout(() => startUpload(uploadId), 100)
    },
    [startUpload]
  )

  const stats = {
    total: queue.length,
    queued: queue.filter((u) => u.status === 'queued').length,
    uploading: queue.filter((u) => u.status === 'uploading').length,
    paused: queue.filter((u) => u.status === 'paused').length,
    completed: queue.filter((u) => u.status === 'completed').length,
    error: queue.filter((u) => u.status === 'error').length,
  }

  return {
    queue,
    stats,
    addToQueue,
    startUpload,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    removeCompleted,
    clearCompleted,
    retryUpload,
  }
}
