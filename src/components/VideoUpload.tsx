'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { Upload } from 'lucide-react'
import { formatFileSize } from '@/lib/utils'
import { apiFetch, apiPost } from '@/lib/api-client'
import {
  ensureFreshUploadOnContextChange,
  clearTUSFingerprint,
  getUploadMetadata,
  clearUploadMetadata,
} from '@/lib/tus-context'
import { useUploadManager } from '@/components/UploadManagerProvider'

interface VideoUploadProps {
  projectId: string
  videoName: string
  onUploadComplete?: () => void

  videoNotes?: string
  showVideoNotesField?: boolean

  allowApproval?: boolean
  showAllowApprovalField?: boolean
}

export default function VideoUpload({
  projectId,
  videoName,
  onUploadComplete,
  videoNotes: videoNotesProp,
  showVideoNotesField = true,
  allowApproval: allowApprovalProp,
  showAllowApprovalField = true,
}: VideoUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addUpload } = useUploadManager()

  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [versionLabel, setVersionLabel] = useState('')
  const [videoNotes, setVideoNotes] = useState(videoNotesProp ?? '')
  const [allowApproval, setAllowApproval] = useState<boolean>(allowApprovalProp ?? true)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (videoNotesProp !== undefined) {
      setVideoNotes(videoNotesProp)
    }
  }, [videoNotesProp])

  useEffect(() => {
    if (allowApprovalProp !== undefined) {
      setAllowApproval(allowApprovalProp ?? true)
    }
  }, [allowApprovalProp])

  // Validate video file format
  async function validateVideoFile(f: File): Promise<{ valid: boolean; error?: string }> {
    if (f.size === 0) {
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
        reader.readAsArrayBuffer(f.slice(0, 12))
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
        error: 'File does not appear to be a valid MP4/MOV video. Please ensure you are uploading an unencrypted, standard MP4 video file.',
      }
    } catch {
      return { valid: false, error: 'Failed to read file. Please try again.' }
    }
  }

  /**
   * Validate, create the server-side video record, then hand off to the
   * global UploadManager which keeps the TUS upload alive across page
   * navigation.
   */
  async function handleUpload() {
    if (!file) return

    if (!videoName || !videoName.trim()) {
      setError('Video name is required')
      return
    }

    const trimmedVideoName = videoName.trim()
    const trimmedVersionLabel = versionLabel.trim()
    const trimmedVideoNotes = (videoNotes || '').trim()
    if (trimmedVideoNotes.length > 500) {
      setError('Version notes must be 500 characters or fewer')
      return
    }
    const contextKey = `${projectId}:${trimmedVideoName}:${trimmedVersionLabel || 'auto'}`

    setSubmitting(true)
    setError(null)

    try {
      // Validate file format
      const validation = await validateVideoFile(file)
      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid video file')
      }

      // Check if file was uploaded to different project and clear TUS fingerprint if needed
      ensureFreshUploadOnContextChange(file, contextKey)

      const existingMetadata = getUploadMetadata(file)
      let canResume =
        existingMetadata?.projectId === projectId &&
        !!existingMetadata.videoId &&
        existingMetadata?.targetName === trimmedVideoName &&
        (existingMetadata.versionLabel || '') === (trimmedVersionLabel || '')

      if (canResume) {
        try {
          const checkRes = await apiFetch(`/api/videos/${existingMetadata!.videoId}`)
          if (!checkRes.ok) {
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
            canResume = false
          } else {
            const videoData = await checkRes.json()
            if (videoData.status !== 'UPLOADING' && videoData.status !== 'ERROR') {
              clearUploadMetadata(file)
              clearTUSFingerprint(file)
              canResume = false
            }
          }
        } catch {
          clearUploadMetadata(file)
          clearTUSFingerprint(file)
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
          allowApproval: allowApproval === true,
          originalFileName: file.name,
          originalFileSize: file.size,
          name: trimmedVideoName,
        })
        videoId = res.videoId
      }

      // Hand off to the global upload manager — the upload continues
      // even if the user navigates away from this page.
      addUpload({
        file,
        projectId,
        videoId,
        videoName: trimmedVideoName,
        versionLabel: trimmedVersionLabel,
        onComplete: () => onUploadComplete?.(),
      })

      // Reset form
      setFile(null)
      setVersionLabel('')
      setVideoNotes(videoNotesProp !== undefined ? (videoNotesProp ?? '') : '')
      setAllowApproval(allowApprovalProp ?? true)

      // Notify parent so the project page reflects the new UPLOADING record.
      onUploadComplete?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Drag and drop handlers
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

    if (!submitting && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0]
      if (droppedFile.type.startsWith('video/')) {
        setFile(droppedFile)
      } else {
        setError('Please drop a video file')
      }
    }
  }

  return (
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

      {/* Version Label + Allow Approval */}
      <div className={showAllowApprovalField ? 'grid gap-4 sm:grid-cols-2' : 'space-y-2'}>
        <div className="space-y-2">
          <Label htmlFor="versionLabel">Version Label (Optional)</Label>
          <Input
            id="versionLabel"
            value={versionLabel}
            onChange={(e) => setVersionLabel(e.target.value)}
            placeholder="Leave empty for auto-generated label (v1, v2, etc.)"
            disabled={submitting}
          />
        </div>

        {showAllowApprovalField && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Allow approval of version</div>
            <div className="flex items-center gap-2 h-10">
              <Checkbox
                checked={allowApproval}
                onCheckedChange={(v) => setAllowApproval(Boolean(v))}
                disabled={submitting}
                aria-label="Allow approval of version"
              />
              <span className={allowApproval ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                {allowApproval ? 'Clients can approve version' : 'Client approval disabled'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Version Notes */}
      {showVideoNotesField && (
        <div className="space-y-2">
          <Label htmlFor="videoNotes">
            Version Notes <span className="text-muted-foreground dark:text-white">(Optional)</span>
          </Label>
          <Textarea
            id="videoNotes"
            value={videoNotes}
            onChange={(e) => setVideoNotes(e.target.value)}
            placeholder="Optional notes for this version"
            disabled={submitting}
            className="resize-none"
            rows={3}
            maxLength={500}
          />
        </div>
      )}

      {/* File Selection */}
      <div className="space-y-2">
        <Label htmlFor="file">Video File (Original)</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={fileInputRef}
            id="file"
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            disabled={submitting}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            className="w-full sm:w-1/2"
          >
            <Upload className="w-4 h-4 mr-2" />
            {file ? 'Change File' : 'Drag & Drop or Click to Choose'}
          </Button>
          <Button
            type="button"
            onClick={handleUpload}
            disabled={!file || submitting}
            className="w-full sm:w-1/2"
          >
            {submitting ? 'Starting…' : 'Upload Video'}
          </Button>
        </div>
        {file && (
          <p className="text-sm text-muted-foreground">
            Selected: {file.name} ({formatFileSize(file.size)})
          </p>
        )}
      </div>
    </div>
  )
}
