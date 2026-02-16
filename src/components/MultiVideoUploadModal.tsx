'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { Upload, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn, formatFileSize } from '@/lib/utils'
import { apiFetch, apiDelete, apiPost } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import {
  clearFileContext,
  clearTUSFingerprint,
  clearUploadMetadata,
  ensureFreshUploadOnContextChange,
  getUploadMetadata,
  storeUploadMetadata,
} from '@/lib/tus-context'

type UploadStatus = 'pending' | 'uploading' | 'success' | 'error'

type QueuedVideo = {
  id: string
  file: File
  videoName: string
  versionLabel: string
  videoNotes: string
  allowApproval: boolean
  progress: number
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  canFullControl: boolean
  onUploadComplete?: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [items, setItems] = useState<QueuedVideo[]>([])

  const isUploadingAny = useMemo(() => items.some((i) => i.status === 'uploading'), [items])
  const canUpload = items.length > 0 && !isUploadingAny

  useEffect(() => {
    if (!open) {
      setIsDragging(false)
      setGlobalError(null)
      setItems([])
    }
  }, [open])

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
          progress: 0,
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
    if (!isUploadingAny) setIsDragging(true)
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
    if (isUploadingAny) return
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  async function uploadOne(item: QueuedVideo) {
    const file = item.file
    const trimmedVideoName = item.videoName.trim()
    const trimmedVersionLabel = item.versionLabel.trim()
    const trimmedVideoNotes = item.videoNotes.trim()

    if (!trimmedVideoName) {
      throw new Error('Video name is required')
    }
    if (trimmedVideoNotes.length > 500) {
      throw new Error('Version notes must be 500 characters or fewer')
    }

    const contextKey = `${projectId}:${trimmedVideoName}:${trimmedVersionLabel || 'auto'}`

    // Step 0: Validate
    const validation = await validateVideoFile(file)
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid video file')
    }

    // Check if file was uploaded to different project and clear TUS fingerprint if needed
    ensureFreshUploadOnContextChange(file, contextKey)

    const existingMetadata = getUploadMetadata(file)
    let canResumeExisting =
      existingMetadata?.projectId === projectId &&
      !!existingMetadata.videoId &&
      existingMetadata?.targetName === trimmedVideoName &&
      (existingMetadata.versionLabel || '') === (trimmedVersionLabel || '')

    // Verify the server-side record still exists and is resumable before resuming
    if (canResumeExisting) {
      try {
        const checkRes = await apiFetch(`/api/videos/${existingMetadata!.videoId}`)
        if (!checkRes.ok) {
          clearUploadMetadata(file)
          clearTUSFingerprint(file)
          canResumeExisting = false
        } else {
          const videoData = await checkRes.json()
          if (videoData.status !== 'UPLOADING' && videoData.status !== 'ERROR') {
            // Video moved past upload phase (PROCESSING/READY) — start fresh
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
            canResumeExisting = false
          }
        }
      } catch {
        clearUploadMetadata(file)
        clearTUSFingerprint(file)
        canResumeExisting = false
      }
    }

    let createdVideoRecord = false
    let videoId: string

    if (canResumeExisting) {
      videoId = existingMetadata!.videoId
      storeUploadMetadata(file, {
        videoId,
        projectId,
        versionLabel: existingMetadata?.versionLabel || trimmedVersionLabel,
        targetName: trimmedVideoName,
      })
    } else {
      const res = await apiPost('/api/videos', {
        projectId,
        versionLabel: trimmedVersionLabel,
        videoNotes: trimmedVideoNotes,
        allowApproval: item.allowApproval === true,
        originalFileName: file.name,
        originalFileSize: file.size,
        name: trimmedVideoName,
      })

      videoId = res.videoId
      createdVideoRecord = true

      storeUploadMetadata(file, {
        videoId,
        projectId,
        versionLabel: trimmedVersionLabel,
        targetName: trimmedVideoName,
      })
    }

    await new Promise<void>(async (resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: `${window.location.origin}/api/uploads`,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        chunkSize: 50 * 1024 * 1024,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        metadata: {
          filename: file.name,
          filetype: file.type || 'video/mp4',
          videoId,
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
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100)
          updateItem(item.id, { progress: percentage })
        },
        onSuccess: () => {
          clearFileContext(file)
          clearUploadMetadata(file)
          clearTUSFingerprint(file)
          resolve()
        },
        onError: async (error) => {
          const statusCode = (error as any)?.originalResponse?.getStatus?.()

          if (canResumeExisting && (statusCode === 404 || statusCode === 410)) {
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
          } else if (createdVideoRecord && videoId) {
            try {
              await apiDelete(`/api/videos/${videoId}`)
            } catch {}
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
          }

          reject(error)
        },
      })

      try {
        const previousUploads = await upload.findPreviousUploads()
        if (previousUploads.length > 0) {
          upload.resumeFromPreviousUpload(previousUploads[0])
        } else if (!createdVideoRecord && canResumeExisting) {
          clearUploadMetadata(file)
          clearTUSFingerprint(file)
        }
      } catch {
        // ignore
      }

      upload.start()
    })
  }

  async function handleUploadAll() {
    setGlobalError(null)

    // Validate queue before starting
    const firstInvalid = items.find((i) => !i.videoName.trim())
    if (firstInvalid) {
      updateItem(firstInvalid.id, { error: 'Video name is required' })
      setGlobalError('Please fill in all required fields')
      return
    }

    let successCount = 0
    let failureCount = 0

    for (const item of items) {
      if (item.status === 'success') {
        successCount += 1
        continue
      }

      updateItem(item.id, { status: 'uploading', error: null, progress: 0 })
      try {
        await uploadOne(item)
        updateItem(item.id, { status: 'success', progress: 100 })
        successCount += 1
      } catch (err: any) {
        const message = typeof err?.message === 'string' && err.message.trim()
          ? err.message
          : 'Upload failed'
        updateItem(item.id, { status: 'error', error: message })
        failureCount += 1
        // continue with remaining
      }
    }

    if (successCount > 0) {
      onUploadComplete?.()
    }

    // If everything succeeded, close the modal.
    if (failureCount === 0) {
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isUploadingAny && onOpenChange(next)}>
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
                  disabled={isUploadingAny}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingAny}
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
                <div key={item.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{item.file.name}</div>
                      <div className="text-xs text-muted-foreground">{formatFileSize(item.file.size)}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeItem(item.id)}
                      disabled={item.status === 'uploading'}
                      title="Remove"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor={`videoName-${item.id}`}>Video Name *</Label>
                      <Input
                        id={`videoName-${item.id}`}
                        value={item.videoName}
                        onChange={(e) => updateItem(item.id, { videoName: e.target.value, error: null })}
                        disabled={item.status === 'uploading'}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`versionLabel-${item.id}`}>Version Label (Optional)</Label>
                      <Input
                        id={`versionLabel-${item.id}`}
                        value={item.versionLabel}
                        onChange={(e) => updateItem(item.id, { versionLabel: e.target.value })}
                        placeholder="Leave empty for auto-generated label (v1, v2, etc.)"
                        disabled={item.status === 'uploading'}
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
                        disabled={item.status === 'uploading'}
                      />
                    </div>

                    {canFullControl && (
                      <div className="space-y-2 sm:col-span-2">
                        <div className="text-sm font-medium">Allow approval of version</div>
                        <div className="flex items-center gap-2 h-10">
                          <Checkbox
                            checked={item.allowApproval}
                            onCheckedChange={(v) => updateItem(item.id, { allowApproval: Boolean(v) })}
                            disabled={item.status === 'uploading'}
                            aria-label="Allow approval of version"
                          />
                          <span className={item.allowApproval ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                            {item.allowApproval ? 'Clients can approve version' : 'Client approval disabled'}
                          </span>
                        </div>
                      </div>
                    )}

                    {(item.status === 'uploading' || item.status === 'success') && (
                      <div className="sm:col-span-2 space-y-2">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">
                            {item.status === 'success' ? 'Uploaded' : 'Uploading...'}
                          </span>
                          <span className="font-medium">{item.progress}%</span>
                        </div>
                        <div className="relative h-3 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className={cn('h-full transition-all', item.status === 'success' ? 'bg-success' : 'bg-primary')}
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
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

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isUploadingAny}>
            Cancel
          </Button>
          <Button type="button" onClick={handleUploadAll} disabled={!canUpload}>
            Upload Video/s
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
