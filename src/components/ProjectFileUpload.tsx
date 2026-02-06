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

interface ProjectFileUploadProps {
  projectId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
  title?: string
  description?: string
  layout?: 'stacked' | 'headerRow'
}

type QueuedProjectFileUpload = {
  id: string
  file: File
  projectFileId: string | null
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null
  tusUpload: tus.Upload | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export function ProjectFileUpload({
  projectId,
  onUploadComplete,
  maxConcurrent = 3,
  title = 'Files (Multiple)',
  description,
  layout = 'stacked',
}: ProjectFileUploadProps) {
  const hasDescription = String(description || '').trim().length > 0
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueuedProjectFileUpload[]>([])
  const refreshAttemptsRef = useRef<Map<string, number>>(new Map())

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [queue, setQueue] = useState<QueuedProjectFileUpload[]>([])
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

  const addFilesToQueue = (files: File[]) => {
    if (!files || files.length === 0) return

    const errors: string[] = []
    const nextItems: QueuedProjectFileUpload[] = []

    for (const f of files) {
      const validation = validateFile(f)
      if (!validation.valid) {
        errors.push(`${f.name}: ${validation.error || 'Invalid file type'}`)
        continue
      }

      nextItems.push({
        id: generateUploadId(),
        file: f,
        projectFileId: null,
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

  const generateUploadId = (): string => {
    const cryptoObj: Crypto | undefined = (globalThis as any).crypto
    if (cryptoObj?.randomUUID) return `project-upload-${Date.now()}-${cryptoObj.randomUUID()}`
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16)
      cryptoObj.getRandomValues(bytes)
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return `project-upload-${Date.now()}-${hex}`
    }
    return `project-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  const activeCounts = useMemo(() => {
    return queue.reduce(
      (acc, u) => {
        acc[u.status] += 1
        return acc
      },
      { queued: 0, uploading: 0, paused: 0, completed: 0, error: 0 } as Record<QueuedProjectFileUpload['status'], number>
    )
  }, [queue])

  const hasActiveUploads = activeCounts.uploading > 0 || activeCounts.queued > 0 || activeCounts.paused > 0

  const addSelectedToQueue = () => addFilesToQueue(selectedFiles)

  const updateUpload = (id: string, patch: Partial<QueuedProjectFileUpload>) => {
    setQueue((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }

  const startUpload = useCallback(
    async (id: string) => {
      const upload = queueRef.current.find((u) => u.id === id)
      if (!upload || upload.status !== 'queued') return

      updateUpload(id, { status: 'uploading', startedAt: Date.now(), error: null, progress: 0, uploadSpeed: 0 })

      let projectFileId: string | null = null
      try {
        const response = await apiPost(`/api/projects/${projectId}/files`, {
          fileName: upload.file.name,
          fileSize: upload.file.size,
          mimeType: upload.file.type || 'application/octet-stream',
        })

        projectFileId = response?.projectFileId
        if (!projectFileId) throw new Error('Failed to create upload record')

        updateUpload(id, { projectFileId })

        const startTime = Date.now()
        let lastLoaded = 0
        let lastTime = startTime

        const tusUpload = new tus.Upload(upload.file, {
          endpoint: '/api/uploads',
          retryDelays: [0, 1000, 3000, 5000, 10000],
          metadata: {
            filename: upload.file.name,
            filetype: upload.file.type || 'application/octet-stream',
            projectFileId,
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
              speedMBps = bytesDiff / timeDiff / (1024 * 1024)
              lastLoaded = bytesUploaded
              lastTime = now
            }

            updateUpload(id, {
              progress: percentage,
              uploadSpeed:
                speedMBps > 0.05
                  ? Math.round(speedMBps * 10) / 10
                  : queueRef.current.find((u) => u.id === id)?.uploadSpeed || 0,
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
                    // fall through
                  }
                }
              }
            }

            // Clean up DB record on error
            const latest = queueRef.current.find((u) => u.id === id)
            const recordId = latest?.projectFileId || projectFileId
            if (recordId) {
              try {
                await apiDelete(`/api/projects/${projectId}/files/${recordId}`)
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
        const recordId = latest?.projectFileId || projectFileId
        if (recordId) {
          try {
            await apiDelete(`/api/projects/${projectId}/files/${recordId}`)
          } catch {}
        }
        updateUpload(id, { status: 'error', error: e?.message || 'Upload failed', tusUpload: null })
        refreshAttemptsRef.current.delete(id)
      }
    },
    [onUploadComplete, projectId]
  )

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

    if (upload.projectFileId) {
      try {
        await apiDelete(`/api/projects/${projectId}/files/${upload.projectFileId}`)
      } catch {}
    }

    refreshAttemptsRef.current.delete(id)

    setQueue((prev) => prev.filter((u) => u.id !== id))
  }

  const retryUpload = async (id: string) => {
    refreshAttemptsRef.current.delete(id)
    updateUpload(id, {
      status: 'queued',
      error: null,
      progress: 0,
      uploadSpeed: 0,
      projectFileId: null,
      tusUpload: null,
    })
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

  const selectedSummary = useMemo(() => {
    if (selectedFiles.length === 0) return null
    const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
    return { count: selectedFiles.length, totalSize }
  }, [selectedFiles])

  const headerRowPicker = (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (hasActiveUploads) return
        if (e.dataTransfer.files.length > 0) {
          addFilesToQueue(Array.from(e.dataTransfer.files))
        }
      }}
      className="flex justify-end"
    >
      <Input
        ref={fileInputRef}
        id="project-files"
        type="file"
        multiple
        onChange={(e) => {
          const files = e.target.files
          if (!files || files.length === 0) return
          addFilesToQueue(Array.from(files))
        }}
        className="hidden"
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        disabled={hasActiveUploads}
        aria-label="Add Files"
      >
        <Upload className="w-4 h-4 sm:mr-2" />
        <span className="hidden sm:inline">Add Files</span>
      </Button>
    </div>
  )

  const picker = (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        rounded-lg border-2 border-dashed transition-all
        ${isDragging ? 'border-primary bg-primary/5 scale-[1.01] p-4' : 'border-border bg-muted/30 hover:bg-muted/50 p-6'}
      `}
    >
      <div className="space-y-2">
        {layout === 'stacked' && <Label htmlFor="project-files">{title}</Label>}

        <Input
          ref={fileInputRef}
          id="project-files"
          type="file"
          multiple
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
        />

        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full" disabled={hasActiveUploads}>
          <Upload className="w-4 h-4 mr-2" />
          {selectedFiles.length > 0 ? 'Change Files' : 'Drag & Drop or Click to Choose'}
        </Button>

        {selectedSummary && (
          <div className="text-xs text-muted-foreground">
            {selectedSummary.count} file{selectedSummary.count === 1 ? '' : 's'} selected • {formatFileSize(selectedSummary.totalSize)} total
          </div>
        )}

        {selectedFiles.length > 0 && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="default" size="sm" onClick={addSelectedToQueue} disabled={hasActiveUploads}>
              Add to Upload Queue
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedFiles([])
                setError(null)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
              disabled={hasActiveUploads}
            >
              Clear
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {layout === 'headerRow' ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-medium">{title}</div>
            {hasDescription && (
              <p className="text-xs text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          <div className="shrink-0">{headerRowPicker}</div>
        </div>
      ) : (
        picker
      )}

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive whitespace-pre-line">{error}</p>
        </div>
      )}

      {queue.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Upload Queue</div>
            <div className="flex items-center gap-2">
              {activeCounts.completed > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={clearCompleted}>
                  Clear completed
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {queue.map((u) => {
              const isWorking = u.status === 'uploading'
              const isError = u.status === 'error'
              const isDone = u.status === 'completed'
              const isPaused = u.status === 'paused'

              return (
                <div key={u.id} className="border rounded-lg bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{u.file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(u.file.size)}
                        {u.uploadSpeed > 0 && isWorking ? ` • ${u.uploadSpeed} MB/s` : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isWorking && (
                        <Button type="button" variant="outline" size="sm" onClick={() => pauseUpload(u.id)} title="Pause">
                          <Pause className="w-4 h-4" />
                        </Button>
                      )}
                      {isPaused && (
                        <Button type="button" variant="outline" size="sm" onClick={() => resumeUpload(u.id)} title="Resume">
                          <Play className="w-4 h-4" />
                        </Button>
                      )}
                      {isError && (
                        <Button type="button" variant="outline" size="sm" onClick={() => void retryUpload(u.id)} title="Retry">
                          <RotateCw className="w-4 h-4" />
                        </Button>
                      )}
                      <Button type="button" variant="outline" size="sm" onClick={() => void cancelUpload(u.id)} title="Remove">
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 bg-muted rounded overflow-hidden">
                        <div
                          className={
                            'h-full transition-all ' +
                            (isError ? 'bg-destructive' : isDone ? 'bg-emerald-500' : 'bg-primary')
                          }
                          style={{ width: `${Math.min(100, Math.max(0, u.progress))}%` }}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums w-10 text-right">{u.progress}%</div>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      {u.status === 'queued' && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Queued
                        </span>
                      )}
                      {u.status === 'uploading' && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Uploading
                        </span>
                      )}
                      {u.status === 'paused' && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Pause className="w-3.5 h-3.5" />
                          Paused
                        </span>
                      )}
                      {u.status === 'completed' && (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Completed
                        </span>
                      )}
                      {u.status === 'error' && (
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <AlertCircle className="w-3.5 h-3.5" />
                          {u.error || 'Error'}
                        </span>
                      )}
                    </div>

                    {u.status === 'error' && u.error && (
                      <div className="text-xs text-destructive whitespace-pre-line">{u.error}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {activeCounts.queued === 0 && activeCounts.uploading === 0 && activeCounts.paused === 0 && (
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setQueue([])
                }}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Clear all
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
