import { useState, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertCircle, Upload, X } from 'lucide-react'
import { getAllowedFileTypesDescription, validateCommentFile } from '@/lib/fileUpload'

interface FileUploadModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onFileSelect: (files: File[]) => Promise<void>
  isLoading?: boolean
  error?: string
  quota?: { usedBytes: number; limitMB: number } | null
  portalContainer?: HTMLElement | null
}

export function FileUploadModal({
  open,
  onOpenChange,
  onFileSelect,
  isLoading = false,
  error: externalError = '',
  quota = null,
  portalContainer = null,
}: FileUploadModalProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      handleFiles(Array.from(files))
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files))
    }
  }

  const handleFiles = async (files: File[]) => {
    setError('')

    try {
      for (const file of files) {
        const validation = validateCommentFile(file.name, file.type, file.size)
        if (!validation.valid) {
          throw new Error(validation.error || 'File is not allowed')
        }
      }

      await onFileSelect(files)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const displayError = externalError || error

  const usedMB = quota ? Math.max(0, quota.usedBytes) / (1024 * 1024) : null
  const availableLabel = quota
    ? (quota.limitMB === 0 ? 'Unlimited' : `${quota.limitMB} MB`)
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent portalContainer={portalContainer} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Attach a file to your comment
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {displayError && (
            <div className="flex gap-3 p-3 bg-destructive-visible border border-destructive-visible rounded-lg">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{displayError}</p>
            </div>
          )}

          {/* Drag and Drop Area */}
          <div
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border bg-muted/30 hover:bg-muted/50'
            }`}
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium mb-1">Drag and drop your file here</p>
            <p className="text-xs text-muted-foreground mb-3">or click the button below</p>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileInput}
              className="hidden"
              disabled={isLoading}
            />

            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              variant="outline"
              size="sm"
            >
              {isLoading ? 'Uploading...' : 'Select File'}
            </Button>
          </div>

          {/* File Types Info */}
          <div className="bg-muted/50 p-3 rounded-lg">
            {quota && (
              <p className="text-xs text-foreground font-semibold mb-2">
                Data Used: {usedMB !== null ? `${usedMB.toFixed(0)} MB` : '0 MB'} / Data Available: {availableLabel}
              </p>
            )}
            <p className="text-xs text-muted-foreground font-medium mb-1">Supported file types:</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {getAllowedFileTypesDescription()}
            </p>
          </div>

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
