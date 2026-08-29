'use client'

import { useId, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { formatFileSize } from '@/lib/utils'
import { validateAssetExtension, detectAssetCategory } from '@/lib/asset-validation'

export interface PendingAsset {
  /** Stable key for list rendering and removal — File objects aren't reliably unique. */
  key: string
  file: File
  category: string
}

interface PendingAssetPickerProps {
  assets: PendingAsset[]
  onChange: (assets: PendingAsset[]) => void
  disabled?: boolean
  /** Rendered without the top hairline when it isn't the last block in a panel. */
  bordered?: boolean
}

function makeKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Choose asset files to upload alongside a video that doesn't exist yet.
 *
 * The normal asset queue uploads immediately against a known videoId; here there isn't
 * one until the version is created, so files are only held in memory and handed back to
 * the caller, which queues them once the video's own upload has landed. Validation and
 * category detection happen at pick time so a rejected file is reported here rather than
 * failing invisibly later.
 */
export function PendingAssetPicker({
  assets,
  onChange,
  disabled = false,
  bordered = true,
}: PendingAssetPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const addFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return

    const errors: string[] = []
    const accepted: PendingAsset[] = []

    for (const file of Array.from(files)) {
      if (file.size === 0) {
        errors.push(`${file.name}: file is empty`)
        continue
      }
      const validation = validateAssetExtension(file.name)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error}`)
        continue
      }
      accepted.push({ key: makeKey(file), file, category: detectAssetCategory(file.name) || '' })
    }

    setError(errors.length > 0 ? errors.join('\n') : null)
    if (accepted.length > 0) onChange([...assets, ...accepted])
    if (inputRef.current) inputRef.current.value = ''
  }

  const totalBytes = assets.reduce((sum, a) => sum + a.file.size, 0)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (disabled) return
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
  }

  return (
    <div className={bordered ? 'border-t pt-3 space-y-4' : 'space-y-4'}>
      {/* Mirrors the version card's own asset panel (VideoAssetUploadQueue): same label,
          same full-width drop target, same drag highlight — the only difference is that
          these files wait for the video instead of uploading immediately. */}
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
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
            <p className="text-sm text-destructive whitespace-pre-line">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={inputId}>Upload Asset Files (Multiple)</Label>
            <span className="text-xs text-muted-foreground">
              {assets.length > 0
                ? `${assets.length} ${assets.length === 1 ? 'file' : 'files'} · ${formatFileSize(totalBytes)} · uploads once the video lands`
                : 'Uploaded once the video lands'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              id={inputId}
              type="file"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              disabled={disabled}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              className="w-full"
            >
              <Upload className="w-4 h-4 mr-2" />
              {assets.length > 0 ? 'Add More Files' : 'Drag & Drop or Click to Choose'}
            </Button>
          </div>
        </div>
      </div>

      {assets.length > 0 && (
        <div className="rounded-md border divide-y">
          {assets.map((asset) => (
            <div key={asset.key} className="flex items-center gap-2 p-2">
              <span className="text-sm truncate">{asset.file.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(asset.file.size)}
                {asset.category ? ` · ${asset.category}` : ''}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto h-7 w-7 shrink-0"
                onClick={() => onChange(assets.filter((a) => a.key !== asset.key))}
                disabled={disabled}
                aria-label={`Remove ${asset.file.name}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
