'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Paperclip, Upload, X } from 'lucide-react'

export interface AttachmentItem {
  id: string
  name: string
}

interface AttachmentsPanelProps {
  items: AttachmentItem[]
  /** Whether the upload button is shown. */
  canUpload?: boolean
  /** Called with the selected files when the user picks files. Parent owns the upload logic. */
  onUpload?: (files: File[]) => Promise<void>
  onDownload: (item: AttachmentItem) => Promise<void>
  onDelete?: (item: AttachmentItem) => Promise<void>
  uploading?: boolean
  deletingId?: string | null
  label?: string
}

export function AttachmentsPanel({
  items,
  canUpload = false,
  onUpload,
  onDownload,
  onDelete,
  uploading = false,
  deletingId = null,
  label = 'Attachments',
}: AttachmentsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [error, setError] = useState('')

  async function handleFilesChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setPendingFiles(files)
    setError('')
    try {
      await onUpload?.(files)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setPendingFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>

      {items.length === 0 && !canUpload && (
        <p className="text-xs text-muted-foreground">No attachments.</p>
      )}

      {items.length > 0 && (
        <div className="space-y-1">
          {items.map(item => (
            <div key={item.id} className="flex items-center gap-2 text-sm">
              <Paperclip className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <button
                type="button"
                onClick={() => void onDownload(item)}
                className="text-primary hover:underline text-sm truncate max-w-xs text-left"
                title={item.name}
              >
                {item.name}
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={() => void onDelete(item)}
                  disabled={deletingId === item.id}
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  aria-label={`Delete ${item.name}`}
                >
                  {deletingId === item.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <X className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            multiple
            className="hidden"
            onChange={handleFilesChosen}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || pendingFiles.length > 0}
            className="h-7 text-xs"
          >
            {uploading || pendingFiles.length > 0
              ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Uploading…</>
              : <><Upload className="w-3 h-3 mr-1.5" />Add file{items.length > 0 ? 's' : ''}</>}
          </Button>
          {pendingFiles.length > 0 && !uploading && (
            <p className="text-xs text-muted-foreground mt-1">
              {pendingFiles.map(f => f.name).join(', ')}
            </p>
          )}
          {error && <p className="text-xs text-destructive mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}
