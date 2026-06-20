'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload } from 'lucide-react'
import { useAlbumPhotoUploadQueue } from '@/hooks/useAlbumPhotoUploadQueue'
import { validateAlbumPhotoFile } from '@/lib/photo-validation'
import { AlbumPhotoUploadItem } from '@/components/AlbumPhotoUploadItem'

interface AlbumPhotoUploadQueueProps {
  albumId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
}

export function AlbumPhotoUploadQueue({ albumId, onUploadComplete, maxConcurrent = 3 }: AlbumPhotoUploadQueueProps) {
  const MAX_PHOTOS_PER_BATCH = 300

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const { queue, stats, addToQueue, pauseUpload, resumeUpload, cancelUpload, removeCompleted, retryUpload } =
    useAlbumPhotoUploadQueue({ albumId, maxConcurrent, onUploadComplete })

  function validatePhotoFile(file: File): { valid: boolean; error?: string } {
    if (file.size === 0) return { valid: false, error: 'File is empty' }

    const result = validateAlbumPhotoFile(file.name, file.type || 'application/octet-stream')
    if (!result.valid) return { valid: false, error: result.error }

    return { valid: true }
  }

  // Selecting (or dropping) files adds them straight to the queue, which starts
  // uploading immediately — no separate "add to queue" step.
  const handleFileSelect = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return

    let next = Array.from(files)
    const errors: string[] = []

    if (next.length > MAX_PHOTOS_PER_BATCH) {
      next = next.slice(0, MAX_PHOTOS_PER_BATCH)
      errors.push(`Only the first ${MAX_PHOTOS_PER_BATCH} photos were added.`)
    }

    next.forEach((file) => {
      const validation = validatePhotoFile(file)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error}`)
      } else {
        addToQueue(file)
      }
    })

    setError(errors.length > 0 ? errors.join('\n') : null)
    if (fileInputRef.current) fileInputRef.current.value = ''
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
            <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={`album-photo-file-${albumId}`}>Photos (JPG/JPEG, Multiple)</Label>
          <div className="flex items-center gap-2">
            <Input
              ref={fileInputRef}
              id={`album-photo-file-${albumId}`}
              type="file"
              multiple
              accept="image/jpeg,.jpg,.jpeg"
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full">
              <Upload className="w-4 h-4 mr-2" />
              {queue.length > 0 ? 'Add More Photos' : 'Drag & Drop or Click to Choose'}
            </Button>
          </div>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="flex items-center gap-4 p-3 rounded-md border bg-muted/50 text-sm">
          {stats.uploading > 0 && <span className="font-medium text-primary">{stats.uploading} uploading</span>}
          {stats.queued > 0 && <span className="text-muted-foreground">{stats.queued} queued</span>}
          {stats.paused > 0 && <span className="text-warning">{stats.paused} paused</span>}
          {stats.completed > 0 && <span className="text-success">{stats.completed} completed</span>}
          {stats.error > 0 && <span className="text-destructive">{stats.error} failed</span>}
        </div>
      )}

      {queue.length > 0 && (
        <div className="space-y-2">
          {queue.map((upload) => (
            <AlbumPhotoUploadItem
              key={upload.id}
              upload={upload}
              onPause={() => pauseUpload(upload.id)}
              onResume={() => resumeUpload(upload.id)}
              onCancel={() => cancelUpload(upload.id)}
              onRemove={() => removeCompleted(upload.id)}
              onRetry={() => retryUpload(upload.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
