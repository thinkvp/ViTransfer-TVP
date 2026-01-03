import { Button } from '@/components/ui/button'
import { Trash2, Download } from 'lucide-react'

interface AttachedFileDisplayProps {
  fileName: string
  fileSize: number
  onRemove?: () => void
  isLoading?: boolean
}

export function AttachedFileDisplay({
  fileName,
  fileSize,
  onRemove,
  isLoading = false,
}: AttachedFileDisplayProps) {
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  return (
    <div className="flex items-center gap-2 p-2 bg-muted rounded-lg text-sm">
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{fileName}</p>
        <p className="text-xs text-muted-foreground">{formatFileSize(fileSize)}</p>
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={isLoading}
          className="h-8 w-8 p-0 hover:bg-destructive/10"
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      )}
    </div>
  )
}

interface CommentFileDisplayProps {
  fileId: string
  fileName: string
  fileSize: number
  commentId: string
  onDownload?: (fileId: string) => Promise<void>
  isLoading?: boolean
}

export function CommentFileDisplay({
  fileId,
  fileName,
  fileSize,
  commentId,
  onDownload,
  isLoading = false,
}: CommentFileDisplayProps) {
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  const handleDownload = async () => {
    if (onDownload) {
      try {
        await onDownload(fileId)
      } catch (err) {
        console.error('Error downloading file:', err)
      }
    }
  }

  if (onDownload) {
    return (
      <button
        type="button"
        onClick={handleDownload}
        disabled={isLoading}
        className="inline-flex items-center gap-2 px-3 py-2 bg-muted/30 border border-border text-foreground rounded-lg hover:bg-muted/50 transition-colors text-sm font-medium disabled:opacity-50"
      >
        <Download className="w-4 h-4" />
        {fileName} ({formatFileSize(fileSize)})
      </button>
    )
  }

  return (
    <a
      href={`/api/comments/${commentId}/files/${fileId}`}
      className="inline-flex items-center gap-2 px-3 py-2 bg-muted/30 border border-border text-foreground rounded-lg hover:bg-muted/50 transition-colors text-sm font-medium"
      download
    >
      <Download className="w-4 h-4" />
      {fileName} ({formatFileSize(fileSize)})
    </a>
  )
}
