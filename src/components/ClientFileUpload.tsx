'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, Trash2, Pause, Play, X, CheckCircle2, AlertCircle, Loader2, RotateCw } from 'lucide-react'
import * as tus from 'tus-js-client'
import { apiDelete, apiPost, attemptRefresh } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { formatFileSize } from '@/lib/utils'
import { validateAssetExtension } from '@/lib/asset-validation'

interface ClientFileUploadProps {
  clientId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
}

type QueuedClientFileUpload = {
  id: string
  file: File
  clientFileId: string | null
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null
  tusUpload: tus.Upload | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export function ClientFileUpload({ clientId, onUploadComplete, maxConcurrent = 3 }: ClientFileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueuedClientFileUpload[]>([])
  const refreshAttemptsRef = useRef<Map<string, number>>(new Map())

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [queue, setQueue] = useState<QueuedClientFileUpload[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  function validateFile(f: File): { valid: boolean; error?: string } {
    if (f.size === 0) return { valid: false, error: 'File is empty' }
    return validateAssetExtension(f.name)
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
    if (cryptoObj?.randomUUID) return `client-upload-${Date.now()}-${cryptoObj.randomUUID()}`
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16)
      cryptoObj.getRandomValues(bytes)
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
      return `client-upload-${Date.now()}-${hex}`
    }
    return `client-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  const activeCounts = useMemo(() => {
    return queue.reduce(
      (acc, u) => {
        acc[u.status] += 1
        return acc
      },
      { queued: 0, uploading: 0, paused: 0, completed: 0, error: 0 } as Record<QueuedClientFileUpload['status'], number>
    )
  }, [queue])

  const hasActiveUploads = activeCounts.uploading > 0 || activeCounts.queued > 0 || activeCounts.paused > 0

  const addSelectedToQueue = () => {
    if (selectedFiles.length === 0) return

    const errors: string[] = []
    const nextItems: QueuedClientFileUpload[] = []

    for (const f of selectedFiles) {
      const validation = validateFile(f)
      if (!validation.valid) {
        errors.push(`${f.name}: ${validation.error || 'Invalid file type'}`)
        continue
      }

      nextItems.push({
        id: generateUploadId(),
        file: f,
        clientFileId: null,
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

  const updateUpload = (id: string, patch: Partial<QueuedClientFileUpload>) => {
    setQueue((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }

  const startUpload = useCallback(async (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload || upload.status !== 'queued') return

    updateUpload(id, { status: 'uploading', startedAt: Date.now(), error: null, progress: 0, uploadSpeed: 0 })

    let clientFileId: string | null = null
    try {
      const response = await apiPost(`/api/clients/${clientId}/files`, {
        fileName: upload.file.name,
        fileSize: upload.file.size,
        mimeType: upload.file.type || 'application/octet-stream',
      })

      clientFileId = response?.clientFileId
      if (!clientFileId) throw new Error('Failed to create upload record')

      updateUpload(id, { clientFileId })

      const startTime = Date.now()
      let lastLoaded = 0
      let lastTime = startTime

      const tusUpload = new tus.Upload(upload.file, {
        endpoint: '/api/uploads',
        retryDelays: [0, 1000, 3000, 5000, 10000],
        metadata: {
          filename: upload.file.name,
          filetype: upload.file.type || 'application/octet-stream',
          clientFileId,
        },
        chunkSize: 50 * 1024 * 1024,
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
            uploadSpeed: speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : queueRef.current.find((u) => u.id === id)?.uploadSpeed || 0,
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

          // If auth failed, attempt a single refresh and resume the upload.
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
                  // fall through to normal error handling
                }
              }
            }
          }

          // Clean up DB record on error
          const latest = queueRef.current.find((u) => u.id === id)
          const recordId = latest?.clientFileId || clientFileId
          if (recordId) {
            try {
              await apiDelete(`/api/clients/${clientId}/files/${recordId}`)
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
      const latest = queueRef.current.find((u) => u.id === id)
      const recordId = latest?.clientFileId || clientFileId
      if (recordId) {
        try {
          await apiDelete(`/api/clients/${clientId}/files/${recordId}`)
        } catch {}
      }
      updateUpload(id, { status: 'error', error: e?.message || 'Upload failed', tusUpload: null })
      refreshAttemptsRef.current.delete(id)
    }
  }, [clientId, onUploadComplete])

  useEffect(() => {
    const uploading = queue.filter((u) => u.status === 'uploading').length
    if (uploading >= maxConcurrent) return

    const available = maxConcurrent - uploading
    const nextIds = queue
      .filter((u) => u.status === 'queued')
      .slice(0, available)
      .map((u) => u.id)

    if (nextIds.length === 0) return
    nextIds.forEach((id) => void startUpload(id))
  }, [queue, maxConcurrent, startUpload])

  const pauseUpload = (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload?.tusUpload || upload.status !== 'uploading') return
    upload.tusUpload.abort()
    updateUpload(id, { status: 'paused' })
  }

  const resumeUpload = (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload?.tusUpload || upload.status !== 'paused') return
    upload.tusUpload.start()
    updateUpload(id, { status: 'uploading' })
  }

  const cancelUpload = async (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload) return

    try {
      upload.tusUpload?.abort(true)
    } catch {}

    if (upload.clientFileId) {
      try {
        await apiDelete(`/api/clients/${clientId}/files/${upload.clientFileId}`)
      } catch {}
    }

    refreshAttemptsRef.current.delete(id)

    setQueue((prev) => prev.filter((u) => u.id !== id))
  }

  const retryUpload = async (id: string) => {
    // Reset to queued; the scheduler effect will start it
    refreshAttemptsRef.current.delete(id)
    updateUpload(id, { status: 'queued', error: null, progress: 0, uploadSpeed: 0, clientFileId: null, tusUpload: null })
  }

  const clearCompleted = () => {
    setQueue((prev) => prev.filter((u) => u.status !== 'completed'))
  }

  // Drag and drop handlers
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
          ${isDragging
            ? 'border-primary bg-primary/5 scale-[1.01] p-4'
            : 'border-transparent'
          }
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
              id="client-files"
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
              Selected: {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} ({formatFileSize(selectedFiles.reduce((sum, f) => sum + f.size, 0))} total)
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
            {activeCounts.uploading > 0 && (
              <span className="font-medium text-primary">{activeCounts.uploading} uploading</span>
            )}
            {activeCounts.queued > 0 && (
              <span className="text-muted-foreground">{activeCounts.queued} queued</span>
            )}
            {activeCounts.paused > 0 && (
              <span className="text-warning">{activeCounts.paused} paused</span>
            )}
            {activeCounts.completed > 0 && (
              <span className="text-success">{activeCounts.completed} completed</span>
            )}
            {activeCounts.error > 0 && (
              <span className="text-destructive">{activeCounts.error} failed</span>
            )}
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
          <h5 className="text-sm font-medium text-muted-foreground">Upload Queue ({queue.length})</h5>
          <div className="space-y-2">
            {queue.map((u) => (
              <div key={u.id} className="flex items-start gap-3 p-3 rounded-md border bg-card">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{u.file.name}</p>
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        <span>{formatFileSize(u.file.size)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 text-xs font-medium">
                      {u.status === 'queued' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {u.status === 'paused' && <Pause className="h-4 w-4 text-warning" />}
                      {u.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-success" />}
                      {u.status === 'error' && <AlertCircle className="h-4 w-4 text-destructive" />}
                      <span
                        className={
                          u.status === 'error'
                            ? 'text-destructive'
                            : u.status === 'completed'
                              ? 'text-success'
                              : u.status === 'paused'
                                ? 'text-warning'
                                : 'text-muted-foreground'
                        }
                      >
                        {u.status === 'queued'
                          ? 'Queued'
                          : u.status === 'uploading'
                            ? 'Uploading...'
                            : u.status === 'paused'
                              ? 'Paused'
                              : u.status === 'completed'
                                ? 'Complete'
                                : 'Failed'}
                      </span>
                    </div>
                  </div>

                  {['queued', 'uploading', 'paused'].includes(u.status) && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{u.status === 'paused' ? 'Paused' : 'Uploading...'}</span>
                        <span className="font-medium">{u.progress}%</span>
                      </div>
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className={`h-full transition-all ${u.status === 'paused' ? 'bg-warning' : 'bg-primary'}`}
                          style={{ width: `${u.progress}%` }}
                        />
                      </div>
                      {u.status === 'uploading' && u.uploadSpeed > 0 && (
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Speed: {u.uploadSpeed} MB/s</span>
                        </div>
                      )}
                    </div>
                  )}

                  {u.status === 'error' && u.error && (
                    <p className="text-xs text-destructive">{u.error}</p>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {u.status === 'uploading' && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => pauseUpload(u.id)} title="Pause upload" className="h-8 w-8">
                      <Pause className="h-4 w-4" />
                    </Button>
                  )}

                  {u.status === 'paused' && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => resumeUpload(u.id)} title="Resume upload" className="h-8 w-8">
                      <Play className="h-4 w-4" />
                    </Button>
                  )}

                  {u.status === 'error' && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => void retryUpload(u.id)} title="Retry upload" className="h-8 w-8">
                      <RotateCw className="h-4 w-4" />
                    </Button>
                  )}

                  {['queued', 'uploading', 'paused', 'error'].includes(u.status) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void cancelUpload(u.id)}
                      title="Cancel upload"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {queue.length === 0 && null}
    </div>
  )
}
