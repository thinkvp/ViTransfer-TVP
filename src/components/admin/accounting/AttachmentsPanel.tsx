'use client'

import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Paperclip, X } from 'lucide-react'

export interface AttachmentItem {
  id: string
  name: string
}

interface AttachmentsPanelProps {
  items: AttachmentItem[]
  /** Whether the upload drop zone is shown. */
  canUpload?: boolean
  /** Called with the selected files when the user picks or drops files. Parent owns the upload logic. */
  onUpload?: (files: File[]) => Promise<void>
  onDownload: (item: AttachmentItem) => Promise<void>
  onDelete?: (item: AttachmentItem) => Promise<void>
  uploading?: boolean
  deletingId?: string | null
  label?: string | null
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
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')

  async function handleFiles(files: File[]) {
    if (files.length === 0) return
    setError('')
    try {
      await onUpload?.(files)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}

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
            onChange={e => void handleFiles(Array.from(e.target.files ?? []))}
          />
          <div
            onClick={() => { if (!uploading) fileInputRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); if (!uploading) setDragOver(true) }}
            onDragEnter={e => { e.preventDefault(); if (!uploading) setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault()
              setDragOver(false)
              if (!uploading) void handleFiles(Array.from(e.dataTransfer.files))
            }}
            className={cn(
              'flex items-center justify-center gap-1.5 border border-dashed rounded px-3 py-2 text-xs transition-colors',
              uploading
                ? 'opacity-60 cursor-not-allowed border-border text-muted-foreground'
                : dragOver
                  ? 'border-primary bg-primary/10 text-foreground cursor-copy'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground cursor-pointer',
            )}
          >
            {uploading
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />Uploading…</>
              : <><Paperclip className="w-3.5 h-3.5 shrink-0" />Drop files or click to attach</>}
          </div>
          {error && <p className="text-xs text-destructive mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}
