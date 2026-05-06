'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Upload, Trash2, Pause, Play, X, CheckCircle2, AlertCircle, Loader2, RotateCw } from 'lucide-react'
import * as tus from 'tus-js-client'
import { apiDelete, apiPost, attemptRefresh } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { formatFileSize } from '@/lib/utils'
import { validateAssetExtension } from '@/lib/asset-validation'
import { useTransferTuning } from '@/lib/transfer-tuning-client'

interface UserFileUploadProps {
  userId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
}

type QueuedUserFileUpload = {
  id: string
  file: File
  userFileId: string | null
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null
  tusUpload: tus.Upload | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export function UserFileUpload({ userId, onUploadComplete, maxConcurrent = 3 }: UserFileUploadProps) {
  const { uploadChunkSizeBytes } = useTransferTuning()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueuedUserFileUpload[]>([])
  const refreshAttemptsRef = useRef<Map<string, number>>(new Map())

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [queue, setQueue] = useState<QueuedUserFileUpload[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  function validateFile(file: File): { valid: boolean; error?: string } {
    if (file.size === 0) return { valid: false, error: 'File is empty' }
    return validateAssetExtension(file.name)
  }

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  const handleFileSelect = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) {
      setSelectedFiles([])
      setError(null)
      return
    }
    setSelectedFiles(Array.from(files))
    setError(null)
  }

  const generateUploadId = (): string => {
    const cryptoObj: Crypto | undefined = (globalThis as any).crypto
    if (cryptoObj?.randomUUID) return `user-upload-${Date.now()}-${cryptoObj.randomUUID()}`
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16)
      cryptoObj.getRandomValues(bytes)
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
      return `user-upload-${Date.now()}-${hex}`
    }
    return `user-upload-${Date.now()}-${crypto.randomUUID()}`
  }

  const activeCounts = useMemo(() => {
    return queue.reduce(
      (acc, upload) => {
        acc[upload.status] += 1
        return acc
      },
      { queued: 0, uploading: 0, paused: 0, completed: 0, error: 0 } as Record<QueuedUserFileUpload['status'], number>
    )
  }, [queue])

  const hasActiveUploads = activeCounts.uploading > 0 || activeCounts.queued > 0 || activeCounts.paused > 0

  const addSelectedToQueue = () => {
    if (selectedFiles.length === 0) return

    const errors: string[] = []
    const nextItems: QueuedUserFileUpload[] = []

    for (const file of selectedFiles) {
      const validation = validateFile(file)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error || 'Invalid file type'}`)
        continue
      }

      nextItems.push({
        id: generateUploadId(),
        file,
        userFileId: null,
        status: 'queued',
        progress: 0,
        uploadSpeed: 0,
        error: null,
        tusUpload: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
      })
    }

    if (errors.length > 0) {
      setError(errors.join('\n'))
      return
    }

    setQueue((prev) => [...prev, ...nextItems])
    setSelectedFiles([])
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const updateUpload = (id: string, patch: Partial<QueuedUserFileUpload>) => {
    setQueue((prev) => prev.map((upload) => (upload.id === id ? { ...upload, ...patch } : upload)))
  }

  const startUpload = useCallback(async (id: string) => {
    const upload = queueRef.current.find((item) => item.id === id)
    if (!upload || upload.status !== 'queued') return

    updateUpload(id, { status: 'uploading', startedAt: Date.now(), error: null, progress: 0, uploadSpeed: 0 })

    let userFileId: string | null = null
    try {
      const response = await apiPost(`/api/users/${userId}/files`, {
        fileName: upload.file.name,
        fileSize: upload.file.size,
        mimeType: upload.file.type || 'application/octet-stream',
      })

      userFileId = response?.userFileId
      if (!userFileId) throw new Error('Failed to create upload record')

      updateUpload(id, { userFileId })

      const startTime = Date.now()
      let lastLoaded = 0
      let lastTime = startTime

      const tusUpload = new tus.Upload(upload.file, {
        endpoint: '/api/uploads',
        retryDelays: [0, 1000, 3000, 5000, 10000],
        metadata: {
          filename: upload.file.name,
          filetype: upload.file.type || 'application/octet-stream',
          userFileId,
        },
        chunkSize: uploadChunkSizeBytes,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100)

          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000
          const bytesDiff = bytesUploaded - lastLoaded
          let speedMBps = 0
          if (timeDiff > 0.5) {
            speedMBps = (bytesDiff / timeDiff) / (1024 * 1024)
            lastLoaded = bytesUploaded
            lastTime = now
          }

          updateUpload(id, {
            progress: percentage,
            uploadSpeed: speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : queueRef.current.find((item) => item.id === id)?.uploadSpeed || 0,
          })
        },
        onSuccess: () => {
          refreshAttemptsRef.current.delete(id)
          updateUpload(id, { status: 'completed', progress: 100, completedAt: Date.now(), tusUpload: null })
          onUploadComplete?.()
        },
        onError: async (err) => {
          let errorMessage = 'Upload failed'
          if (err.message?.includes('NetworkError') || err.message?.includes('Failed to fetch')) {
            errorMessage = 'Network error. Please check your connection and try again.'
          } else if (err.message?.includes('413')) {
            errorMessage = 'File is too large. Please choose a smaller file.'
          } else if (err.message?.includes('401') || err.message?.includes('403')) {
            errorMessage = 'Authentication failed. Please log in again.'
          } else if (err.message) {
            errorMessage = err.message
          }

          const statusCode = (err as any)?.originalResponse?.getStatus?.()
          if (statusCode === 401 || statusCode === 403) {
            const attempts = refreshAttemptsRef.current.get(id) || 0
            if (attempts < 1) {
              refreshAttemptsRef.current.set(id, attempts + 1)
              const refreshed = await attemptRefresh()
              if (refreshed) {
                try {
                  tusUpload.start()
                  return
                } catch {
                  // fall through
                }
              }
            }
          }

          const latest = queueRef.current.find((item) => item.id === id)
          const recordId = latest?.userFileId || userFileId
          if (recordId) {
            try {
              await apiDelete(`/api/users/${userId}/files/${recordId}`)
            } catch {}
          }

          updateUpload(id, { status: 'error', error: errorMessage, tusUpload: null })
          refreshAttemptsRef.current.delete(id)
        },
        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject()
          xhr.withCredentials = true
          const token = getAccessToken()
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        },
      })

      updateUpload(id, { tusUpload })
      tusUpload.start()
    } catch (e: any) {
      const latest = queueRef.current.find((item) => item.id === id)
      const recordId = latest?.userFileId || userFileId
      if (recordId) {
        try {
          await apiDelete(`/api/users/${userId}/files/${recordId}`)
        } catch {}
      }
      updateUpload(id, { status: 'error', error: e?.message || 'Upload failed', tusUpload: null })
      refreshAttemptsRef.current.delete(id)
    }
  }, [onUploadComplete, uploadChunkSizeBytes, userId])

  useEffect(() => {
    const uploading = queue.filter((upload) => upload.status === 'uploading').length
    if (uploading >= maxConcurrent) return

    const available = maxConcurrent - uploading
    const nextIds = queue
      .filter((upload) => upload.status === 'queued')
      .slice(0, available)
      .map((upload) => upload.id)

    if (nextIds.length === 0) return
    nextIds.forEach((id) => void startUpload(id))
  }, [maxConcurrent, queue, startUpload])

  const pauseUpload = (id: string) => {
    const upload = queueRef.current.find((item) => item.id === id)
    if (!upload?.tusUpload || upload.status !== 'uploading') return
    upload.tusUpload.abort()
    updateUpload(id, { status: 'paused' })
  }

  const resumeUpload = (id: string) => {
    const upload = queueRef.current.find((item) => item.id === id)
    if (!upload?.tusUpload || upload.status !== 'paused') return
    upload.tusUpload.start()
    updateUpload(id, { status: 'uploading' })
  }

  const cancelUpload = async (id: string) => {
    const upload = queueRef.current.find((item) => item.id === id)
    if (!upload) return

    try {
      upload.tusUpload?.abort(true)
    } catch {}

    if (upload.userFileId) {
      try {
        await apiDelete(`/api/users/${userId}/files/${upload.userFileId}`)
      } catch {}
    }

    refreshAttemptsRef.current.delete(id)
    setQueue((prev) => prev.filter((item) => item.id !== id))
  }

  const retryUpload = async (id: string) => {
    refreshAttemptsRef.current.delete(id)
    updateUpload(id, { status: 'queued', error: null, progress: 0, uploadSpeed: 0, userFileId: null, tusUpload: null })
  }

  const clearCompleted = () => {
    setQueue((prev) => prev.filter((upload) => upload.status !== 'completed'))
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files)
    }
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          space-y-4 rounded-lg border-2 border-dashed transition-all
          ${isDragging ? 'border-primary bg-primary/5 scale-[1.01] p-4' : 'border-transparent'}
        `}
      >
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
            <p className="text-sm text-destructive whitespace-pre-line">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              ref={fileInputRef}
              id="user-files"
              type="file"
              multiple
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
              disabled={hasActiveUploads}
            >
              <Upload className="w-4 h-4 mr-2" />
              {selectedFiles.length > 0 ? 'Change Files' : 'Drag & Drop or Click to Choose'}
            </Button>
          </div>
          {selectedFiles.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Selected: {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} ({formatFileSize(selectedFiles.reduce((sum, file) => sum + file.size, 0))} total)
            </p>
          )}
        </div>

        {selectedFiles.length > 0 && (
          <Button type="button" onClick={addSelectedToQueue} className="w-full">
            <Upload className="w-4 h-4 mr-2" />
            Add to Upload Queue
          </Button>
        )}
      </div>

      {queue.length > 0 && (
        <div className="flex items-center justify-between p-3 rounded-md border bg-muted/50">
          <div className="flex gap-4 text-sm">
            {activeCounts.uploading > 0 && <span className="font-medium text-primary">{activeCounts.uploading} uploading</span>}
            {activeCounts.queued > 0 && <span className="text-muted-foreground">{activeCounts.queued} queued</span>}
            {activeCounts.paused > 0 && <span className="text-warning">{activeCounts.paused} paused</span>}
            {activeCounts.completed > 0 && <span className="text-success">{activeCounts.completed} completed</span>}
            {activeCounts.error > 0 && <span className="text-destructive">{activeCounts.error} failed</span>}
          </div>

          {activeCounts.completed > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={clearCompleted} className="text-xs">
              <Trash2 className="w-3 h-3 mr-1" />
              Clear Completed
            </Button>
          )}
        </div>
      )}

      {queue.length > 0 && (
        <div className="space-y-2">
          {queue.map((upload) => (
            <div key={upload.id} className="border rounded-lg p-3 bg-card space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{upload.file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatFileSize(upload.file.size)}
                    {upload.uploadSpeed > 0 && upload.status === 'uploading' ? ` • ${upload.uploadSpeed} MB/s` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {upload.status === 'uploading' && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => pauseUpload(upload.id)}>
                      <Pause className="w-4 h-4" />
                    </Button>
                  )}
                  {upload.status === 'paused' && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => resumeUpload(upload.id)}>
                      <Play className="w-4 h-4" />
                    </Button>
                  )}
                  {upload.status === 'error' && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void retryUpload(upload.id)}>
                      <RotateCw className="w-4 h-4" />
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" onClick={() => void cancelUpload(upload.id)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    upload.status === 'completed' ? 'bg-success' : upload.status === 'error' ? 'bg-destructive' : 'bg-primary'
                  }`}
                  style={{ width: `${upload.progress}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1">
                  {upload.status === 'queued' && <Loader2 className="w-3 h-3 animate-spin" />}
                  {upload.status === 'uploading' && <Loader2 className="w-3 h-3 animate-spin" />}
                  {upload.status === 'paused' && <Pause className="w-3 h-3" />}
                  {upload.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-success" />}
                  {upload.status === 'error' && <AlertCircle className="w-3 h-3 text-destructive" />}
                  <span className={upload.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                    {upload.status === 'queued' && 'Queued'}
                    {upload.status === 'uploading' && 'Uploading'}
                    {upload.status === 'paused' && 'Paused'}
                    {upload.status === 'completed' && 'Completed'}
                    {upload.status === 'error' && (upload.error || 'Failed')}
                  </span>
                </div>
                <span className="text-muted-foreground">{upload.progress}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
