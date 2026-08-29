'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { Upload } from 'lucide-react'
import { formatFileSize, parseVersionFromFilename } from '@/lib/utils'
import { apiFetch, apiPost } from '@/lib/api-client'
import {
  ensureFreshUploadOnContextChange,
  clearTUSFingerprint,
  getUploadMetadata,
  clearUploadMetadata,
} from '@/lib/tus-context'
import { useUploadManagerActions } from '@/components/UploadManagerProvider'
import { VersionAssetCarryOver, type CarryOverSelection } from './VersionAssetCarryOver'
import { PendingAssetPicker, type PendingAsset } from './PendingAssetPicker'
import { enqueueAssetUploads } from '@/hooks/useAssetUploadQueue'
import { useTransferTuning } from '@/lib/transfer-tuning-client'
import { toast } from 'sonner'

/** Module-scope constant: a fresh [] default would change identity on every render. */
const EMPTY_SIBLINGS: string[] = []

interface VideoUploadProps {
  projectId: string
  videoName: string
  onUploadComplete?: () => void

  videoNotes?: string
  showVideoNotesField?: boolean

  allowApproval?: boolean
  showAllowApprovalField?: boolean

  /** When true, show the per-version "Auto-generate subtitles" tickbox (i.e. Whisper is enabled globally). */
  transcriptionEnabled?: boolean

  /**
   * Existing versions of the video being added to. Non-empty only on the "add version"
   * path, where their assets can be carried forward onto the new version.
   */
  siblingVideoIds?: string[]
}

export default function VideoUpload({
  projectId,
  videoName,
  onUploadComplete,
  videoNotes: videoNotesProp,
  showVideoNotesField = true,
  allowApproval: allowApprovalProp,
  showAllowApprovalField = true,
  transcriptionEnabled = false,
  siblingVideoIds = EMPTY_SIBLINGS,
}: VideoUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addUpload } = useUploadManagerActions()

  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [versionLabel, setVersionLabel] = useState('')
  const [videoNotes, setVideoNotes] = useState(videoNotesProp ?? '')
  const [allowApproval, setAllowApproval] = useState<boolean>(allowApprovalProp ?? true)
  const [autoGenerateSubtitles, setAutoGenerateSubtitles] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [carryOver, setCarryOver] = useState<CarryOverSelection[]>([])
  const [pendingAssets, setPendingAssets] = useState<PendingAsset[]>([])
  const { uploadChunkSizeBytes } = useTransferTuning()

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
   * Copy the selected earlier-version assets onto the freshly created version.
   *
   * One request per source version, newest first: the copy API skips a filename already
   * on the target, so ordering is what makes the newest version win a name collision.
   * Runs after the version exists and reports on its own — the upload has already
   * succeeded by this point and must not be reported as failed if a copy is.
   */
  async function copyCarryOverAssets(
    targetVideoId: string,
    targetLabel: string,
    selection: CarryOverSelection[],
  ) {
    let copied = 0
    const notCopied: string[] = []
    const fromLabels: string[] = []

    for (const source of selection) {
      try {
        const result = await apiPost<{ copiedCount?: number; results?: Array<{ fileName: string; status: string; reason?: string }> }>(
          `/api/videos/${source.sourceVideoId}/assets/copy-to-version`,
          { assetIds: source.assetIds, targetVideoId },
        )
        const fromThis = result?.copiedCount ?? 0
        copied += fromThis
        if (fromThis > 0) fromLabels.push(source.versionLabel)
        for (const row of result?.results ?? []) {
          if (row.status !== 'copied') {
            notCopied.push(`${row.fileName}${row.reason ? ` — ${row.reason}` : ''}`)
          }
        }
      } catch (err) {
        notCopied.push(`${source.versionLabel} — ${err instanceof Error ? err.message : 'copy failed'}`)
      }
    }

    const detail = notCopied.length > 0 ? { description: notCopied.join('\n') } : undefined
    if (copied > 0) {
      const from = fromLabels.length > 0 ? ` from ${fromLabels.join(', ')}` : ''
      const suffix = notCopied.length > 0 ? ` · ${notCopied.length} not copied` : ''
      toast.success(`${copied} ${copied === 1 ? 'asset' : 'assets'} copied to ${targetLabel}${from}${suffix}`, detail)
    } else {
      toast.warning(`No assets copied to ${targetLabel}`, detail)
    }

    // Surface the copies in the version list without waiting for the upload to finish.
    onUploadComplete?.()
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
          autoGenerateSubtitles: transcriptionEnabled ? autoGenerateSubtitles === true : false,
          originalFileName: file.name,
          originalFileSize: file.size,
          name: trimmedVideoName,
        })
        videoId = res.videoId
      }

      // Snapshot the selections: the form resets below, and the callback runs long after.
      const pendingCarryOver = carryOver
      const assetsToUpload = pendingAssets

      // Hand off to the global upload manager — the upload continues
      // even if the user navigates away from this page.
      addUpload({
        file,
        projectId,
        videoId,
        videoName: trimmedVideoName,
        versionLabel: trimmedVersionLabel,
        onComplete: () => {
          onUploadComplete?.()
          // Carry the chosen assets forward only once the upload has actually landed.
          // The version record exists from the moment it's created, but a failed upload
          // DELETES it (UploadManagerProvider's onError), which would strand a copy
          // mid-flight against a row that no longer exists — foreign-key failures for
          // what's left and orphaned StoredFile rows for what already went through.
          if (pendingCarryOver.length > 0) {
            void copyCarryOverAssets(videoId, trimmedVersionLabel || 'the new version', pendingCarryOver)
          }
          if (assetsToUpload.length > 0) {
            const queued = enqueueAssetUploads(
              videoId,
              assetsToUpload.map((a) => ({ file: a.file, category: a.category })),
              { uploadChunkSizeBytes },
            )
            toast.success(
              `${queued} ${queued === 1 ? 'asset' : 'assets'} queued for ${trimmedVersionLabel || 'the new version'}`,
              { description: 'Progress shows in the version’s asset panel.' },
            )
          }
        },
      })

      // Reset form
      setFile(null)
      setVersionLabel('')
      setVideoNotes(videoNotesProp !== undefined ? (videoNotesProp ?? '') : '')
      setAllowApproval(allowApprovalProp ?? true)
      setPendingAssets([])

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
        const { versionLabel: detected } = parseVersionFromFilename(droppedFile.name)
        if (detected) setVersionLabel(detected)
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

      {/* Version Label + Allow Approval + Subtitles */}
      {(() => {
        const cols = 1 + (showAllowApprovalField ? 1 : 0) + (transcriptionEnabled ? 1 : 0)
        const gridClass = cols === 3 ? 'grid gap-4 sm:grid-cols-3' : cols === 2 ? 'grid gap-4 sm:grid-cols-2' : 'space-y-2'
        return (
      <div className={gridClass}>
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

        {transcriptionEnabled && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Subtitles</div>
            <div className="flex items-center gap-2 h-10">
              <Checkbox
                checked={autoGenerateSubtitles}
                onCheckedChange={(v) => setAutoGenerateSubtitles(Boolean(v))}
                disabled={submitting}
                aria-label="Auto-generate subtitles"
              />
              <span className={autoGenerateSubtitles ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                {autoGenerateSubtitles ? 'Auto-generate' : 'Off — set manually'}
              </span>
            </div>
          </div>
        )}
      </div>
        )
      })()}

      {/* Version Notes */}
      {showVideoNotesField && (
        <div className="space-y-2">
          <Label htmlFor="videoNotes">
            Version Notes <span className="text-white">(Optional)</span>
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
            onChange={(e) => {
              const selected = e.target.files?.[0] || null
              setFile(selected)
              if (selected) {
                const { versionLabel: detected } = parseVersionFromFilename(selected.name)
                if (detected) setVersionLabel(detected)
              }
            }}
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

      {/* Carry assets forward from earlier versions. Sits below the file picker: it's a
          step after the upload is set up, not another option about the video itself. */}
      {siblingVideoIds.length > 0 && (
        <VersionAssetCarryOver
          projectId={projectId}
          siblingVideoIds={siblingVideoIds}
          disabled={submitting}
          onChange={setCarryOver}
        />
      )}

      {/* Brand-new assets to upload alongside this version. Queued, like the copies,
          only once the video's own upload has landed. */}
      <PendingAssetPicker
        assets={pendingAssets}
        onChange={setPendingAssets}
        disabled={submitting}
      />
    </div>
  )
}
