'use client'

import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/utils'
import { QueuedAlbumPhotoUpload } from '@/hooks/useAlbumPhotoUploadQueue'
import { AlertCircle, CheckCircle2, Image as ImageIcon, Loader2, Pause, Play, RotateCw, X } from 'lucide-react'

interface AlbumPhotoUploadItemProps {
  upload: QueuedAlbumPhotoUpload
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRemove: () => void
  onRetry: () => void
}

export function AlbumPhotoUploadItem({
  upload,
  onPause,
  onResume,
  onCancel,
  onRemove,
  onRetry,
}: AlbumPhotoUploadItemProps) {
  const getStatusIcon = () => {
    switch (upload.status) {
      case 'queued':
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      case 'paused':
        return <Pause className="h-4 w-4 text-warning" />
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-success" />
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />
      default:
        return null
    }
  }

  const getStatusText = () => {
    switch (upload.status) {
      case 'queued':
        return 'Queued'
      case 'uploading':
        return 'Uploading...'
      case 'paused':
        return 'Paused'
      case 'completed':
        return 'Complete'
      case 'error':
        return 'Failed'
      default:
        return upload.status
    }
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-md border bg-card">
      <div className="mt-0.5">
        <ImageIcon className="h-5 w-5 text-muted-foreground flex-shrink-0" />
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{upload.file.name}</p>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>{formatFileSize(upload.file.size)}</span>
              <span>•</span>
              <span>JPG</span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs font-medium">
            {getStatusIcon()}
            <span
              className={
                upload.status === 'error'
                  ? 'text-destructive'
                  : upload.status === 'completed'
                    ? 'text-success'
                    : upload.status === 'paused'
                      ? 'text-warning'
                      : 'text-muted-foreground'
              }
            >
              {getStatusText()}
            </span>
          </div>
        </div>

        {['queued', 'uploading', 'paused'].includes(upload.status) && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{upload.status === 'paused' ? 'Paused' : 'Uploading...'}</span>
              <span className="font-medium">{upload.progress}%</span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={`h-full transition-all ${upload.status === 'paused' ? 'bg-warning' : 'bg-primary'}`}
                style={{ width: `${upload.progress}%` }}
              />
            </div>

            {upload.status === 'uploading' && upload.uploadSpeed > 0 && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Speed: {upload.uploadSpeed} MB/s</span>
                <span>
                  {(() => {
                    const remainingBytes = upload.file.size * (1 - upload.progress / 100)
                    const seconds = remainingBytes / (upload.uploadSpeed * 1024 * 1024)
                    const eta = Math.max(0, Math.ceil(seconds))
                    return eta > 0 ? `Estimated: ${eta} seconds` : 'Estimated: <1 second'
                  })()}
                </span>
              </div>
            )}
          </div>
        )}

        {upload.status === 'error' && upload.error && <p className="text-xs text-destructive">{upload.error}</p>}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        {upload.status === 'uploading' && (
          <Button type="button" variant="ghost" size="icon" onClick={onPause} title="Pause upload" className="h-8 w-8">
            <Pause className="h-4 w-4" />
          </Button>
        )}

        {upload.status === 'paused' && (
          <Button type="button" variant="ghost" size="icon" onClick={onResume} title="Resume upload" className="h-8 w-8">
            <Play className="h-4 w-4" />
          </Button>
        )}

        {upload.status === 'error' && (
          <Button type="button" variant="ghost" size="icon" onClick={onRetry} title="Retry upload" className="h-8 w-8">
            <RotateCw className="h-4 w-4" />
          </Button>
        )}

        {['queued', 'uploading', 'paused', 'error'].includes(upload.status) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCancel}
            title="Cancel upload"
            className="h-8 w-8 text-destructive hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        {upload.status === 'completed' && (
          <Button type="button" variant="ghost" size="icon" onClick={onRemove} title="Remove" className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
