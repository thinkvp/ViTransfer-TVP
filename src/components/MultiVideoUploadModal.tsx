'use client'

import { useEffect, useRef, useState } from 'react'
import { Upload, X, Cloud } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn, formatFileSize } from '@/lib/utils'
import { apiFetch, apiPost } from '@/lib/api-client'
import {
  clearTUSFingerprint,
  clearUploadMetadata,
  ensureFreshUploadOnContextChange,
  getUploadMetadata,
} from '@/lib/tus-context'
import { useUploadManagerActions } from '@/components/UploadManagerProvider'

type UploadStatus = 'pending' | 'queued' | 'error'

type QueuedVideo = {
  id: string
  file: File
  videoName: string
  versionLabel: string
  videoNotes: string
  allowApproval: boolean
  dropboxEnabled: boolean
  status: UploadStatus
  error: string | null
}

function stripExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0) return fileName
  return fileName.slice(0, lastDot)
}

async function validateVideoFile(file: File): Promise<{ valid: boolean; error?: string }> {
  if (file.size === 0) {
    return { valid: false, error: 'File is empty' }
  }

  try {
    const headerBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        if (e.target?.result) {
          resolve(new Uint8Array(e.target.result as ArrayBuffer))
        } else {
          reject(new Error('Failed to read file'))
        }
      }
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsArrayBuffer(file.slice(0, 12))
    })

    if (headerBytes.length < 12) {
      return { valid: false, error: 'File is too small to be a valid video' }
    }

    const atomType = String.fromCharCode(...headerBytes.subarray(4, 8))
    if (atomType === 'ftyp' || atomType === 'mdat' || ['wide', 'free', 'moov'].includes(atomType)) {
      return { valid: true }
    }

    return {
      valid: false,
      error:
        'File does not appear to be a valid MP4/MOV video. Please ensure you are uploading an unencrypted, standard MP4 video file.',
    }
  } catch {
    return { valid: false, error: 'Failed to read file. Please try again.' }
  }
}

export default function MultiVideoUploadModal({
  open,
  onOpenChange,
  projectId,
  canFullControl,
  onUploadComplete,
  dropboxConfigured = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  canFullControl: boolean
  onUploadComplete?: () => void
  dropboxConfigured?: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addUpload } = useUploadManagerActions()

  const [isDragging, setIsDragging] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [items, setItems] = useState<QueuedVideo[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [isClosingAfterQueue, setIsClosingAfterQueue] = useState(false)
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null)

  const queuedCount = items.filter((i) => i.status === 'queued').length
  const canUpload = items.length > 0 && items.some((i) => i.status === 'pending') && !submitting && !isClosingAfterQueue

  useEffect(() => {
    if (!open) {
      setIsDragging(false)
      setGlobalError(null)
      setItems([])
      setIsClosingAfterQueue(false)
      setCloseCountdown(null)
    }
  }, [open])

  useEffect(() => {
    if (!open || !isClosingAfterQueue || closeCountdown === null) return

    if (closeCountdown <= 0) {
      onOpenChange(false)
      return
    }

    const timer = window.setTimeout(() => {
      setCloseCountdown((prev) => (prev === null ? prev : prev - 1))
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [closeCountdown, isClosingAfterQueue, onOpenChange, open])

  function getClosingLabel(countdown: number | null) {
    if (countdown === null || countdown <= 0) return 'Closing...'
    return `Closing in ${countdown}...`
  }

  function addFiles(files: FileList | File[]) {
    const accepted = Array.from(files).filter((f) => f.type?.startsWith('video/'))

    if (accepted.length === 0) {
      setGlobalError('Please choose one or more video files')
      return
    }

    setGlobalError(null)

    setItems((prev) => {
      const existingKeys = new Set(prev.map((p) => `${p.file.name}:${p.file.size}:${p.file.lastModified}`))
      const next: QueuedVideo[] = [...prev]

      for (const file of accepted) {
        const key = `${file.name}:${file.size}:${file.lastModified}`
        if (existingKeys.has(key)) continue

        next.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          file,
          videoName: stripExtension(file.name),
          versionLabel: '',
          videoNotes: '',
          allowApproval: canFullControl ? true : false,
          dropboxEnabled: false,
          status: 'pending',
          error: null,
        })
      }

      return next
    })
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id))
  }

  function updateItem(id: string, patch: Partial<QueuedVideo>) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!submitting) setIsDragging(true)
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
    if (submitting) return
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  /**
   * Validate all items, create server-side video records, then enqueue
   * each file with the global UploadManager (which survives page navigation).
   */
  async function handleUploadAll() {
    setGlobalError(null)

    // ---- validation ----
    const pending = items.filter((i) => i.status === 'pending')
    for (const item of pending) {
      if (!item.videoName.trim()) {
        updateItem(item.id, { error: 'Video name is required' })
        setGlobalError('Please fill in all required fields')
        return
      }
      if ((item.videoNotes || '').trim().length > 500) {
        updateItem(item.id, { error: 'Version notes must be 500 characters or fewer' })
        setGlobalError('Please fix the errors below')
        return
      }
    }

    setSubmitting(true)

    // ---- validate file formats ----
    for (const item of pending) {
      const validation = await validateVideoFile(item.file)
      if (!validation.valid) {
        updateItem(item.id, { status: 'error', error: validation.error || 'Invalid video file' })
        setGlobalError('Some files failed validation')
        setSubmitting(false)
        return
      }
    }

    // ---- create video records + enqueue uploads ----
    let enqueued = 0
    let hadUploadErrors = false
    for (const item of pending) {
      const trimmedVideoName = item.videoName.trim()
      const trimmedVersionLabel = item.versionLabel.trim()
      const trimmedVideoNotes = item.videoNotes.trim()
      const contextKey = `${projectId}:${trimmedVideoName}:${trimmedVersionLabel || 'auto'}`

      try {
        ensureFreshUploadOnContextChange(item.file, contextKey)

        const existingMetadata = getUploadMetadata(item.file)
        let canResume =
          existingMetadata?.projectId === projectId &&
          !!existingMetadata.videoId &&
          existingMetadata?.targetName === trimmedVideoName &&
          (existingMetadata.versionLabel || '') === (trimmedVersionLabel || '')

        if (canResume) {
          try {
            const checkRes = await apiFetch(`/api/videos/${existingMetadata!.videoId}`)
            if (!checkRes.ok) {
              clearUploadMetadata(item.file)
              clearTUSFingerprint(item.file)
              canResume = false
            } else {
              const videoData = await checkRes.json()
              if (videoData.status !== 'UPLOADING' && videoData.status !== 'ERROR') {
                clearUploadMetadata(item.file)
                clearTUSFingerprint(item.file)
                canResume = false
              }
            }
          } catch {
            clearUploadMetadata(item.file)
            clearTUSFingerprint(item.file)
            canResume = false
          }
        }

        let videoId: string
        if (canResume) {
          videoId = existingMetadata!.videoId
        } else {
          const res = await apiPost('/api/videos', {
            projectId,
            versionLabel: trimmedVersionLabel,
            videoNotes: trimmedVideoNotes,
            allowApproval: item.allowApproval === true,
            dropboxEnabled: item.dropboxEnabled === true,
            originalFileName: item.file.name,
            originalFileSize: item.file.size,
            name: trimmedVideoName,
          })
          videoId = res.videoId
        }

        addUpload({
          file: item.file,
          projectId,
          videoId,
          videoName: trimmedVideoName,
          versionLabel: trimmedVersionLabel,
          onComplete: () => onUploadComplete?.(),
        })

        updateItem(item.id, { status: 'queued' })
        enqueued++
      } catch (err: any) {
        const message = typeof err?.message === 'string' && err.message.trim() ? err.message : 'Failed to start upload'
        updateItem(item.id, { status: 'error', error: message })
        hadUploadErrors = true
      }
    }

    setSubmitting(false)

    // Close modal if all items were successfully enqueued.
    // Uploads continue in background via UploadManager.
    if (enqueued > 0 && enqueued === pending.length && !hadUploadErrors && !items.some((item) => item.status === 'error')) {
      // Notify parent so the project page can reflect new UPLOADING records.
      onUploadComplete?.()
      setIsClosingAfterQueue(true)
      setCloseCountdown(4)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && !isClosingAfterQueue && onOpenChange(next)}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Video/s</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
          {globalError && (
            <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
              <p className="text-sm text-destructive">{globalError}</p>
            </div>
          )}

          <div
            className={cn(
              'space-y-4 overflow-hidden transition-all duration-300 ease-out',
              isClosingAfterQueue ? 'max-h-0 opacity-0 -translate-y-2 pointer-events-none' : 'max-h-[4000px] opacity-100 translate-y-0'
            )}
          >
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={cn(
                'rounded-lg border-2 border-dashed p-4 transition-all',
                isDragging ? 'border-primary bg-primary/5' : 'border-border'
              )}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="font-medium">Drag & drop videos here</div>
                  <div className="text-sm text-muted-foreground">Or choose files using the button.</div>
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files) addFiles(e.target.files)
                      e.currentTarget.value = ''
                    }}
                    disabled={submitting}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting}
                    className="w-full"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Choose video files
                  </Button>
                </div>
              </div>
            </div>

            {items.length > 0 && (
              <div className="space-y-4">
              {items.map((item) => (
                <div key={item.id} className={cn('rounded-lg border border-border bg-card p-4', item.status === 'queued' && 'opacity-60')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{item.file.name}</div>
                      <div className="text-xs text-muted-foreground">{formatFileSize(item.file.size)}</div>
                    </div>
                    {item.status === 'pending' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => removeItem(item.id)}
                        title="Remove"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor={`videoName-${item.id}`}>Video Name *</Label>
                      <Input
                        id={`videoName-${item.id}`}
                        value={item.videoName}
                        onChange={(e) => updateItem(item.id, { videoName: e.target.value, error: null })}
                        disabled={item.status !== 'pending'}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`versionLabel-${item.id}`}>Version Label (Optional)</Label>
                      <Input
                        id={`versionLabel-${item.id}`}
                        value={item.versionLabel}
                        onChange={(e) => updateItem(item.id, { versionLabel: e.target.value })}
                        placeholder="Leave empty for auto-generated label (v1, v2, etc.)"
                        disabled={item.status !== 'pending'}
                      />
                    </div>

                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor={`videoNotes-${item.id}`}>
                        Version Notes <span className="text-muted-foreground dark:text-white">(Optional)</span>
                      </Label>
                      <Textarea
                        id={`videoNotes-${item.id}`}
                        value={item.videoNotes}
                        onChange={(e) => updateItem(item.id, { videoNotes: e.target.value })}
                        placeholder="Optional notes for this version"
                        className="resize-none"
                        rows={3}
                        maxLength={500}
                        disabled={item.status !== 'pending'}
                      />
                    </div>

                    {canFullControl && (
                      <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="text-sm font-medium">Allow approval of version</div>
                          <div className="flex items-center gap-2 h-10">
                            <Checkbox
                              checked={item.allowApproval}
                              onCheckedChange={(v) => {
                                const checked = Boolean(v)
                                const patch: Partial<QueuedVideo> = { allowApproval: checked }
                                // If disabling approval, also disable Dropbox
                                if (!checked) patch.dropboxEnabled = false
                                updateItem(item.id, patch)
                              }}
                              disabled={item.status !== 'pending'}
                              aria-label="Allow approval of version"
                            />
                            <span className={item.allowApproval ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                              {item.allowApproval ? 'Clients can approve version' : 'Client approval disabled'}
                            </span>
                          </div>
                        </div>

                        {dropboxConfigured && (
                          <div className="space-y-2">
                            <div className="text-sm font-medium">Upload to Dropbox</div>
                            <div className="flex items-center gap-2 h-10">
                              <Checkbox
                                checked={item.dropboxEnabled}
                                onCheckedChange={(v) => updateItem(item.id, { dropboxEnabled: Boolean(v) })}
                                disabled={item.status !== 'pending' || !item.allowApproval}
                                aria-label="Upload to Dropbox"
                              />
                              <Cloud className={`w-4 h-4 ${item.dropboxEnabled && item.allowApproval ? 'text-primary' : 'text-muted-foreground/50'}`} />
                              <span className={item.dropboxEnabled && item.allowApproval ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                                {!item.allowApproval ? 'Requires approval enabled' : item.dropboxEnabled ? 'Download will be served from Dropbox' : 'Local storage only'}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {item.status === 'queued' && (
                      <div className="sm:col-span-2">
                        <p className="text-sm text-muted-foreground flex items-center gap-2">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                          </span>
                          Queued - uploading in background
                        </p>
                      </div>
                    )}

                    {item.error && (
                      <div className="sm:col-span-2 p-3 bg-destructive/10 border border-destructive rounded-md">
                        <p className="text-sm text-destructive">{item.error}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              </div>
            )}
          </div>

          <div
            className={cn(
              'overflow-hidden transition-all duration-300 ease-out',
              isClosingAfterQueue ? 'max-h-24 opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none'
            )}
          >
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                {queuedCount > 1 ? `${queuedCount} videos queued - uploading in background` : 'Queued - uploading in background'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting || isClosingAfterQueue}>
            Cancel
          </Button>
          <Button type="button" onClick={handleUploadAll} disabled={!canUpload}>
            {submitting ? 'Starting…' : isClosingAfterQueue ? getClosingLabel(closeCountdown) : 'Upload Video/s'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
