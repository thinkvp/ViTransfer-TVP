'use client'

import { useState, useRef } from 'react'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Input } from './ui/input'
import { Upload } from 'lucide-react'
import { useAssetUploadQueue } from '@/hooks/useAssetUploadQueue'
import { VideoAssetUploadItem } from './VideoAssetUploadItem'
import { validateAssetExtension, detectAssetCategory } from '@/lib/asset-validation'

interface VideoAssetUploadQueueProps {
  videoId: string
  onUploadComplete?: () => void
  maxConcurrent?: number
}

export function VideoAssetUploadQueue({
  videoId,
  onUploadComplete,
  maxConcurrent = 3
}: VideoAssetUploadQueueProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const {
    queue,
    stats,
    addToQueue,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    removeCompleted,
    retryUpload,
  } = useAssetUploadQueue({
    videoId,
    maxConcurrent,
    onUploadComplete,
  })

  function validateAssetFile(file: File): { valid: boolean; error?: string } {
    if (file.size === 0) {
      return { valid: false, error: 'File is empty' }
    }

    // Don't validate against category - just check if file type is allowed
    // This allows mixing different file types
    return validateAssetExtension(file.name)
  }

  // Selecting (or dropping) files adds them straight to the queue, which starts
  // uploading immediately — no separate "add to queue" step. Category is
  // auto-detected per file.
  const handleFileSelect = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return

    const errors: string[] = []

    Array.from(files).forEach((file) => {
      const validation = validateAssetFile(file)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error}`)
      } else {
        const fileCategory = detectAssetCategory(file.name)
        addToQueue(file, fileCategory || '')
      }
    })

    setError(errors.length > 0 ? errors.join('\n') : null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
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

  const hasActiveUploads = stats.uploading > 0 || stats.queued > 0 || stats.paused > 0

  return (
    <div className="space-y-4">
      {/* File selection area */}
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
        {/* Error Message */}
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* File Selection */}
        <div className="space-y-2">
          <Label htmlFor={`asset-file-${videoId}`}>Upload Asset Files (Multiple)</Label>
          <div className="flex items-center gap-2">
            <Input
              ref={fileInputRef}
              id={`asset-file-${videoId}`}
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
            >
              <Upload className="w-4 h-4 mr-2" />
              {queue.length > 0 ? 'Add More Files' : 'Drag & Drop or Click to Choose'}
            </Button>
          </div>
        </div>
      </div>

      {/* Queue Statistics */}
      {queue.length > 0 && (
        <div className="flex items-center gap-4 p-3 rounded-md border bg-muted/50 text-sm">
          {stats.uploading > 0 && (
            <span className="font-medium text-primary">
              {stats.uploading} uploading
            </span>
          )}
          {stats.queued > 0 && (
            <span className="text-muted-foreground">
              {stats.queued} queued
            </span>
          )}
          {stats.paused > 0 && (
            <span className="text-warning">
              {stats.paused} paused
            </span>
          )}
          {stats.completed > 0 && (
            <span className="text-success">
              {stats.completed} completed
            </span>
          )}
          {stats.error > 0 && (
            <span className="text-destructive">
              {stats.error} failed
            </span>
          )}
        </div>
      )}

      {/* Upload Queue List */}
      {queue.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-sm font-medium text-muted-foreground">
            Upload Queue ({queue.length})
          </h5>
          <div className="space-y-2">
            {queue.map((upload) => (
              <VideoAssetUploadItem
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
        </div>
      )}
    </div>
  )
}
