'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, CheckCircle2, Loader2, Pause, Play, RotateCw, Trash2, Upload, X } from 'lucide-react'
import * as tus from 'tus-js-client'
import { apiDelete, apiPost } from '@/lib/api-client'
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/token-store'
import { formatFileSize } from '@/lib/utils'

interface ProjectEmailUploadProps {
  projectId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
  title?: string
  description?: string
  layout?: 'stacked' | 'headerRow'
}

type QueuedProjectEmailUpload = {
  id: string
  file: File
  projectEmailId: string | null
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'error'
  progress: number
  uploadSpeed: number
  error: string | null
  tusUpload: tus.Upload | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

function validateEmlFile(f: File): { valid: boolean; error?: string } {
  if (!f || !(f instanceof File)) return { valid: false, error: 'Invalid file' }
  if (f.size === 0) return { valid: false, error: 'File is empty' }

  const lower = (f.name || '').toLowerCase()
  if (!lower.endsWith('.eml')) return { valid: false, error: 'Only .eml files are supported' }

  return { valid: true }
}

async function sha256Hex(file: File): Promise<string> {
  const cryptoObj: Crypto | undefined = (globalThis as any).crypto
  if (!cryptoObj?.subtle?.digest) {
    throw new Error('SHA-256 hashing is not available in this browser')
  }

  const buf = await file.arrayBuffer()
  const hashBuf = await cryptoObj.subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(hashBuf)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function ProjectEmailUpload({
  projectId,
  onUploadComplete,
  maxConcurrent = 3,
  title = 'Communication',
  description = '',
  layout = 'stacked',
}: ProjectEmailUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueuedProjectEmailUpload[]>([])
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null)
  const refreshAttemptsRef = useRef<Map<string, number>>(new Map())

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [queue, setQueue] = useState<QueuedProjectEmailUpload[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

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
          headers: {
            Authorization: `Bearer ${refreshToken}`,
          },
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

  const generateUploadId = (): string => {
    const cryptoObj: Crypto | undefined = (globalThis as any).crypto
    if (cryptoObj?.randomUUID) return `project-email-upload-${Date.now()}-${cryptoObj.randomUUID()}`
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16)
      cryptoObj.getRandomValues(bytes)
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return `project-email-upload-${Date.now()}-${hex}`
    }
    return `project-email-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  const activeCounts = useMemo(() => {
    return queue.reduce(
      (acc, u) => {
        acc[u.status] += 1
        return acc
      },
      { queued: 0, uploading: 0, paused: 0, completed: 0, error: 0 } as Record<QueuedProjectEmailUpload['status'], number>
    )
  }, [queue])

  const hasActiveUploads = activeCounts.uploading > 0 || activeCounts.queued > 0 || activeCounts.paused > 0

  const compact = layout === 'headerRow'

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
    const nextItems: QueuedProjectEmailUpload[] = []

    for (const f of files) {
      const validation = validateEmlFile(f)
      if (!validation.valid) {
        errors.push(`${f.name}: ${validation.error || 'Invalid file type'}`)
        continue
      }

      nextItems.push({
        id: generateUploadId(),
        file: f,
        projectEmailId: null,
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

  const addSelectedToQueue = () => addFilesToQueue(selectedFiles)

  const updateUpload = (id: string, patch: Partial<QueuedProjectEmailUpload>) => {
    setQueue((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }

  const startUpload = useCallback(
    async (id: string) => {
      const upload = queueRef.current.find((u) => u.id === id)
      if (!upload || upload.status !== 'queued') return

      updateUpload(id, { status: 'uploading', startedAt: Date.now(), error: null, progress: 0, uploadSpeed: 0 })

      let projectEmailId: string | null = null
      try {
        const sha256 = await sha256Hex(upload.file)

        const response = await apiPost(`/api/projects/${projectId}/emails`, {
          fileName: upload.file.name,
          fileSize: upload.file.size,
          mimeType: upload.file.type || 'message/rfc822',
          sha256,
        })

        projectEmailId = response?.projectEmailId
        if (!projectEmailId) throw new Error('Failed to create upload record')

        updateUpload(id, { projectEmailId })

        const startTime = Date.now()
        let lastLoaded = 0
        let lastTime = startTime

        const tusUpload = new tus.Upload(upload.file, {
          endpoint: '/api/uploads',
          retryDelays: [0, 1000, 3000, 5000, 10000],
          metadata: {
            filename: upload.file.name,
            filetype: upload.file.type || 'message/rfc822',
            projectEmailId,
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

            // Try refresh token once or twice per upload.
            const statusCode = (err as any)?.originalResponse?.getStatus?.()
            if (statusCode === 401 || statusCode === 403) {
              const attempts = refreshAttemptsRef.current.get(id) || 0
              if (attempts < 2) {
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
            const recordId = latest?.projectEmailId || projectEmailId
            if (recordId) {
              try {
                await apiDelete(`/api/projects/${projectId}/emails/${recordId}`)
              } catch {
                // ignore
              }
            }

            updateUpload(id, { status: 'error', error: errorMessage, tusUpload: null })
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
        const recordId = latest?.projectEmailId || projectEmailId
        if (recordId) {
          try {
            await apiDelete(`/api/projects/${projectId}/emails/${recordId}`)
          } catch {
            // ignore
          }
        }
        updateUpload(id, { status: 'error', error: e?.message || 'Upload failed', tusUpload: null })
      }
    },
    [attemptRefresh, onUploadComplete, projectId]
  )

  const pauseUpload = (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload || upload.status !== 'uploading' || !upload.tusUpload) return

    try {
      upload.tusUpload.abort(true)
    } catch {
      // ignore
    }
    updateUpload(id, { status: 'paused', tusUpload: null })
  }

  const resumeUpload = (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (!upload || upload.status !== 'paused') return
    updateUpload(id, { status: 'queued', error: null })
  }

  const retryUpload = (id: string) => {
    updateUpload(id, { status: 'queued', error: null, progress: 0, uploadSpeed: 0 })
  }

  const removeUpload = (id: string) => {
    const upload = queueRef.current.find((u) => u.id === id)
    if (upload?.tusUpload) {
      try {
        upload.tusUpload.abort(true)
      } catch {
        // ignore
      }
    }
    refreshAttemptsRef.current.delete(id)
    setQueue((prev) => prev.filter((u) => u.id !== id))
  }

  // Start queued uploads with concurrency.
  useEffect(() => {
    const uploadingCount = queue.filter((u) => u.status === 'uploading').length
    const queued = queue.filter((u) => u.status === 'queued')

    if (queued.length === 0) return
    if (uploadingCount >= maxConcurrent) return

    const toStart = queued.slice(0, Math.max(0, maxConcurrent - uploadingCount))
    for (const item of toStart) void startUpload(item.id)
  }, [queue, maxConcurrent, startUpload])

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      const next = Array.from(files)
      handleFileSelect(next)
      addFilesToQueue(next)
    }
  }

  const header = (
    <div>
      <div className="text-base font-medium">{title}</div>
      {description && (
        <p className={`text-xs text-muted-foreground mt-1 ${layout === 'headerRow' ? 'hidden sm:block' : ''}`}>
          {description}
        </p>
      )}
    </div>
  )

  return (
    <div className={layout === 'headerRow' ? 'flex items-center justify-between gap-4' : 'space-y-3'}>
      {layout === 'headerRow' && header}

      <div className={layout === 'headerRow' ? 'w-full max-w-xl space-y-3' : 'space-y-3'}>
        {layout !== 'headerRow' && header}

        {error && (
          <div className="flex gap-3 p-3 bg-destructive-visible border border-destructive-visible rounded-lg">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <pre className="text-sm text-destructive whitespace-pre-wrap">{error}</pre>
          </div>
        )}

        <div
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => {
            if (hasActiveUploads) return
            fileInputRef.current?.click()
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (hasActiveUploads) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          className={`border-2 border-dashed rounded-lg ${compact ? 'p-3' : 'p-6'} ${compact ? 'text-left' : 'text-center'} transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:bg-muted/50'
          }`}
        >
          {!compact && <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />}

          <div className={compact ? 'flex items-center justify-between gap-3' : ''}>
            <div className={compact ? 'min-w-0' : ''}>
              <p className={compact ? 'text-sm font-medium' : 'font-medium mb-1'}>
                <span className="hidden sm:inline">Drag & drop .eml files here</span>
                <span className="sm:hidden">Tap to select .eml</span>
              </p>
              {!compact && <p className="hidden sm:block text-xs text-muted-foreground mb-3">or click to select</p>}
              {compact && selectedFiles.length > 0 && (
                <p className="text-xs text-muted-foreground truncate">Selected: {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'}</p>
              )}
            </div>

            {compact && (
              <Button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  fileInputRef.current?.click()
                }}
                disabled={hasActiveUploads}
                variant="outline"
                size="sm"
              >
                Select .eml
              </Button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".eml,message/rfc822"
            multiple
            onChange={(e) => handleFileSelect(e.target.files)}
            className="hidden"
            disabled={hasActiveUploads}
          />

          {!compact && (
            <div className="flex items-center justify-center gap-2">
              <Button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  fileInputRef.current?.click()
                }}
                disabled={hasActiveUploads}
                variant="outline"
                size="sm"
              >
                Select .eml
              </Button>
              {selectedFiles.length > 0 && (
                <Button type="button" onClick={addSelectedToQueue} variant="default" size="sm">
                  Add {selectedFiles.length} to queue
                </Button>
              )}
            </div>
          )}

          {!compact && selectedFiles.length > 0 && (
            <div className="mt-3 text-xs text-muted-foreground">
              {selectedFiles.map((f) => f.name).slice(0, 3).join(', ')}
              {selectedFiles.length > 3 ? ` +${selectedFiles.length - 3} more` : ''}
            </div>
          )}
        </div>

        {queue.length > 0 && (
          <div className="space-y-2">
            {queue.map((u) => (
              <div key={u.id} className="border rounded-lg bg-card px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{u.file.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {formatFileSize(u.file.size)}
                      {u.status === 'uploading' && u.uploadSpeed > 0 ? ` • ${u.uploadSpeed} MB/s` : ''}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {u.status === 'uploading' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => pauseUpload(u.id)}>
                        <Pause className="w-4 h-4" />
                      </Button>
                    )}
                    {u.status === 'paused' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => resumeUpload(u.id)}>
                        <Play className="w-4 h-4" />
                      </Button>
                    )}
                    {u.status === 'error' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => retryUpload(u.id)}>
                        <RotateCw className="w-4 h-4" />
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" onClick={() => removeUpload(u.id)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 w-full rounded bg-muted overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        u.status === 'completed'
                          ? 'bg-emerald-500'
                          : u.status === 'error'
                            ? 'bg-destructive'
                            : 'bg-primary'
                      }`}
                      style={{ width: `${Math.max(0, Math.min(100, u.progress))}%` }}
                    />
                  </div>
                  <div className="w-12 text-right text-xs tabular-nums text-muted-foreground">{u.progress}%</div>
                </div>

                <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    {u.status === 'uploading' && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading
                      </span>
                    )}
                    {u.status === 'queued' && <span className="text-muted-foreground">Queued</span>}
                    {u.status === 'paused' && <span className="text-muted-foreground">Paused</span>}
                    {u.status === 'completed' && (
                      <span className="inline-flex items-center gap-1 text-emerald-600">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Uploaded
                      </span>
                    )}
                    {u.status === 'error' && <span className="text-destructive">{u.error || 'Upload failed'}</span>}
                  </div>
                  <div className="flex-shrink-0">
                    {u.status === 'error' && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeUpload(u.id)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {layout !== 'headerRow' && (
          <div className="text-xs text-muted-foreground">
            Emails are parsed after upload; they may appear after a short delay.
          </div>
        )}
      </div>
    </div>
  )
}
