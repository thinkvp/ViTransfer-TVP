'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileArchive,
  Film,
  Folder,
  FolderSync,
  ImageIcon,
  Loader2,
  Pause,
  Play,
  Share2,
  Upload,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getProcessingPhaseLabel } from '@/lib/video-processing-phase'
import {
  useUploadManager,
  type UploadJob,
  type ProcessingJob,
  type AlbumZipJob,
  type AlbumThumbnailJob,
  type CompletedServerJob,
  type FolderRenameJob,
  type VideoAssetPreviewJob,
  type AlbumSocialJob,
  type ClearRunningJobTarget,
} from '@/components/UploadManagerProvider'
import { useRouter } from 'next/navigation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function formatEtaText(job: UploadJob): string | null {
  if (job.status !== 'uploading' || job.speed <= 0 || job.progress >= 100) return null
  const remainingBytes = job.fileSize * (1 - job.progress / 100)
  const eta = Math.ceil(remainingBytes / (job.speed * 1024 * 1024))
  if (eta <= 0) return '<1s'
  if (eta < 60) return `${eta}s`
  const mins = Math.floor(eta / 60)
  const secs = eta % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

// ---------------------------------------------------------------------------
// Unified job model
// ---------------------------------------------------------------------------

type JobKind =
  | 'upload'
  | 'transcode'
  | 'asset-timeline'
  | 'upload-timeline'
  | 'zip'
  | 'thumbnail'
  | 'rename'
  | 'asset-preview'
  | 'social'
  | 'system'

type JobStatus = 'queued' | 'active' | 'done' | 'failed'

type UnifiedJob = {
  /** Stable unique key: `${kind}:${id}` */
  key: string
  kind: JobKind
  projectId: string
  projectName: string
  label: string
  sublabel?: string
  detail: string
  status: JobStatus
  /** Transcode whose worker died mid-run (no backing queue job). Rendered with a
   * warning icon instead of a spinner, and offers a manual clear. */
  stalled?: boolean
  progress: number
  indeterminate: boolean
  /** Number of discrete items this job represents (1 for most; the batch size for grouped preview/social jobs). Drives project roll-up progress. */
  itemCount: number
  statusLine: string
  statusLineRight?: string
  error?: string
  completedAt: number
  canClear: boolean
  onClear?: () => void
  canDismiss: boolean
  onDismiss?: () => void
  canPause: boolean
  onPause?: () => void
  canResume: boolean
  onResume?: () => void
  subItems?: { key: string; label: string; sublabel?: string; status: 'queued' | 'active' | 'done' }[]
}

// ---------------------------------------------------------------------------
// Icons & labels per kind
// ---------------------------------------------------------------------------

const KIND_ICON: Record<JobKind, React.ComponentType<{ className?: string }>> = {
  'upload': Upload,
  'transcode': Film,
  'asset-timeline': Film,
  'upload-timeline': Film,
  'zip': FileArchive,
  'thumbnail': ImageIcon,
  'rename': FolderSync,
  'asset-preview': Film,
  'social': Share2,
  'system': Wrench,
}

const KIND_LABEL: Record<JobKind, string> = {
  'upload': 'Upload',
  'transcode': 'Transcode',
  'asset-timeline': 'Timeline',
  'upload-timeline': 'Timeline',
  'zip': 'ZIP',
  'thumbnail': 'Thumb',
  'rename': 'Rename',
  'asset-preview': 'Preview',
  'social': 'Social',
  'system': 'System',
}

// ---------------------------------------------------------------------------
// CompactJobRow — slim single-line variant used inside expanded project cards
// ---------------------------------------------------------------------------

function CompactJobRow({
  job,
  onNavigate,
}: {
  job: UnifiedJob
  onNavigate: (projectId: string) => void
}) {
  const Icon = KIND_ICON[job.kind]
  const isActive = job.status === 'active'
  const isQueued = job.status === 'queued'
  const isDone = job.status === 'done'
  const isFailed = job.status === 'failed'
  const showBar = isActive && !job.indeterminate && job.progress > 0

  // Right-hand state indicator.
  const rightText =
    isActive && job.statusLineRight ? job.statusLineRight
    : isActive && !job.indeterminate && job.progress > 0 ? `${job.progress}%`
    : isQueued ? 'queued'
    : null

  // Secondary "what it's doing" line. For active jobs that already surface their
  // percent on the right, strip a trailing "· NN%" to avoid showing it twice.
  const detailLine =
    isFailed ? (job.error || job.statusLine)
    : (isActive || isDone) && job.statusLine
      ? rightText && job.statusLine.endsWith(`· ${rightText}`)
        ? job.statusLine.slice(0, job.statusLine.lastIndexOf('·')).trim()
        : job.statusLine
      : null

  return (
    <div
      className={cn(
        'px-3 py-1.5 transition-colors',
        job.projectId ? 'cursor-pointer hover:bg-accent/30' : '',
      )}
      onClick={() => { if (job.projectId) onNavigate(job.projectId) }}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-shrink-0">
          {isDone ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          ) : isFailed ? (
            <XCircle className="w-3.5 h-3.5 text-destructive" />
          ) : job.stalled ? (
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
          ) : isActive ? (
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          ) : (
            <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </span>
        <span
          className={cn(
            'min-w-0 truncate text-[12px]',
            isDone ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {job.label}
        </span>
        {job.sublabel ? (
          <span className="flex-shrink-0 max-w-[35%] truncate text-[11px] text-muted-foreground/70">
            {job.sublabel}
          </span>
        ) : null}
        {(isActive || isQueued) ? (
          <span className="flex-shrink-0 text-[9px] px-1 py-px rounded bg-muted text-muted-foreground font-medium uppercase tracking-wide">
            {KIND_LABEL[job.kind]}
          </span>
        ) : null}
        <span className="flex-1" />
        {rightText ? (
          <span
            className={cn(
              'flex-shrink-0 text-[11px] tabular-nums',
              isQueued ? 'text-muted-foreground/60' : 'text-muted-foreground',
            )}
          >
            {rightText}
          </span>
        ) : null}
        <div className="flex-shrink-0 flex items-center" onClick={(e) => e.stopPropagation()}>
          {job.canClear && (
            <button
              type="button"
              onClick={job.onClear}
              className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          {job.canDismiss && (
            <button
              type="button"
              onClick={job.onDismiss}
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {detailLine ? (
        <div
          className={cn(
            'pl-5 truncate text-[11px] leading-tight',
            isFailed ? 'text-destructive' : isDone ? 'text-success/80' : 'text-muted-foreground',
          )}
        >
          {detailLine}
        </div>
      ) : null}

      {showBar && (
        <div className="ml-5 mt-1 h-[2px] w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary/70 transition-all duration-700"
            style={{ width: `${job.progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// JobRow — full-size variant used in standalone finished rows
// ---------------------------------------------------------------------------

function JobRow({
  job,
  onNavigate,
}: {
  job: UnifiedJob
  onNavigate: (projectId: string) => void
}) {
  const Icon = KIND_ICON[job.kind]
  const isActive = job.status === 'active'
  const isQueued = job.status === 'queued'
  const isDone = job.status === 'done'
  const isFailed = job.status === 'failed'

  const barWidth = job.indeterminate
    ? '100%'
    : `${Math.max(job.progress, isActive ? 1 : 0)}%`

  return (
    <div
      className={cn(
        'px-4 py-3 space-y-2 transition-colors',
        job.projectId ? 'cursor-pointer hover:bg-accent/40' : '',
      )}
      onClick={() => {
        if (job.projectId) onNavigate(job.projectId)
      }}
    >
      {/* Top row: icon + label + actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <span className="mt-0.5 flex-shrink-0">
            {isDone ? (
              <CheckCircle2 className="w-4 h-4 text-success" />
            ) : isFailed ? (
              <XCircle className="w-4 h-4 text-destructive" />
            ) : job.stalled ? (
              <AlertTriangle className="w-4 h-4 text-warning" />
            ) : isActive ? (
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
            ) : (
              <Icon className="w-4 h-4 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <div className="min-w-0 truncate text-sm font-medium text-foreground">
                {job.label}
              </div>
              {job.sublabel ? (
                <div className="max-w-[40%] truncate text-[11px] text-muted-foreground">
                  {job.sublabel}
                </div>
              ) : null}
              {job.kind !== 'upload' && (isActive || isQueued) ? (
                <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  {KIND_LABEL[job.kind]}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">{job.detail}</div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {job.canPause && (
            <button
              type="button" onClick={job.onPause}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Pause"
            ><Pause className="w-3.5 h-3.5" /></button>
          )}
          {job.canResume && (
            <button
              type="button" onClick={job.onResume}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Resume"
            ><Play className="w-3.5 h-3.5" /></button>
          )}
          {job.canClear && (
            <button
              type="button" onClick={job.onClear}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Cancel"
            ><X className="w-3.5 h-3.5" /></button>
          )}
          {job.canDismiss && (
            <button
              type="button" onClick={job.onDismiss}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Dismiss"
            ><X className="w-3.5 h-3.5" /></button>
          )}
        </div>
      </div>

      {/* Progress bar (active / queued jobs) */}
      {(isActive || isQueued) && (
        <div className="space-y-1">
          {isActive ? (
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-700"
                style={{ width: barWidth }}
              />
              {job.indeterminate ? (
                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_1.5s_ease-in-out_infinite]" />
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span className="truncate">{job.statusLine}</span>
            {job.statusLineRight ? (
              <span className="flex-shrink-0 ml-2">{job.statusLineRight}</span>
            ) : null}
          </div>
        </div>
      )}

      {/* Outcome badges for finished jobs */}
      {isDone && (
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          {job.statusLine}
        </div>
      )}
      {isFailed && (
        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
          <span className="truncate">{job.error || job.statusLine}</span>
        </div>
      )}

      {/* Sub-items */}
      {job.subItems && job.subItems.length > 0 && (
        <div className="space-y-0.5 pt-0.5 border-t border-border/50">
          {job.subItems.map((item) => (
            <div key={item.key} className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full flex-shrink-0',
                  item.status === 'done' ? 'bg-success'
                  : item.status === 'active' ? 'bg-primary'
                  : 'bg-warning',
                )}
              />
              <span className="truncate font-medium text-foreground/70">{item.label}</span>
              {item.sublabel ? (
                <span className="truncate text-muted-foreground/60">{item.sublabel}</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
      {label}{count !== undefined && count > 0 ? ` (${count})` : ''}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Normalizers: each job source → UnifiedJob
// ---------------------------------------------------------------------------

function normalizeUpload(
  job: UploadJob,
  actions: {
    cancel: (id: string) => void
    pause: (id: string) => void
    resume: (id: string) => void
    dismiss: (id: string) => void
  },
): UnifiedJob {
  const status: JobStatus =
    job.status === 'queued' ? 'queued'
    : job.status === 'uploading' ? 'active'
    : job.status === 'paused' ? 'queued'
    : job.status === 'error' ? 'failed'
    : 'done'

  const isUploading = job.status === 'uploading'
  const isPaused = job.status === 'paused'
  const eta = formatEtaText(job)
  const visibleProgress = job.status === 'success' ? 100 : Math.min(job.progress, 99)

  return {
    key: `upload:${job.id}`,
    itemCount: 1,
    kind: 'upload',
    projectId: job.projectId,
    projectName: '',
    label: job.videoName,
    sublabel: job.versionLabel || undefined,
    detail: `${job.fileName} · ${formatSize(job.fileSize)}`,
    status,
    progress: visibleProgress,
    indeterminate: false,
    statusLine:
      status === 'queued'
        ? isPaused ? 'Paused' : 'Waiting in queue…'
        : status === 'done' ? 'Upload complete'
        : status === 'failed' ? job.error || 'Upload failed'
        : job.speed > 0 ? `${job.speed} MB/s` : 'Starting…',
    statusLineRight: status === 'active'
      ? `${visibleProgress}%${eta ? ` · ${eta}` : ''}`
      : undefined,
    error: job.error || undefined,
    completedAt: job.completedAt ?? job.createdAt,
    canClear: status === 'queued' || isUploading || isPaused,
    onClear: () => actions.cancel(job.id),
    canDismiss: status === 'done' || status === 'failed',
    onDismiss: () => actions.dismiss(job.id),
    canPause: isUploading,
    onPause: () => actions.pause(job.id),
    canResume: isPaused,
    onResume: () => actions.resume(job.id),
  }
}

function normalizeProcessing(
  job: ProcessingJob,
  onClear?: () => void,
): UnifiedJob {
  const isQueued = job.status === 'QUEUED'
  const rawProgress = job.processingProgress ?? 0
  const progressPercent = Math.min(
    Math.round(rawProgress <= 1 ? rawProgress * 100 : rawProgress),
    100,
  )
  const phaseLabel = getProcessingPhaseLabel(job.processingPhase)
  const threadBadge =
    job.allocatedThreads && job.threadBudget
      ? ` (${job.allocatedThreads}/${job.threadBudget} threads)`
      : ''

  const sublabel = job.versionLabel || undefined

  // Composite: this version's assets (preview + timeline) are folded in. The
  // server already rolled transcode + assets into processingProgress; here we
  // just surface a combined status line and count assets toward the item total.
  const assets = job.assets ?? []
  const assetTotal = job.assetTotal ?? 0
  const assetDone = job.assetDone ?? 0
  const hasAssets = assetTotal > 0

  const transcodeText = job.processingPhase ? `${phaseLabel}${threadBadge}` : ''
  const assetText = hasAssets ? `${assetDone}/${assetTotal} asset${assetTotal === 1 ? '' : 's'}` : ''
  const activeStatusLine = [transcodeText, assetText].filter(Boolean).join(' · ') || phaseLabel || 'Processing'

  // A stalled transcode (worker died, no backing queue job) is clearable like a
  // queued one, but stays in the active section with a warning icon and label.
  const isStalled = !!job.stalled && !isQueued
  const clearable = isQueued || isStalled

  return {
    key: `transcode:${job.id}`,
    itemCount: 1 + assetTotal,
    kind: 'transcode',
    projectId: job.projectId,
    projectName: job.projectName,
    label: job.videoName,
    sublabel,
    status: isQueued ? 'queued' : 'active',
    stalled: isStalled,
    progress: isQueued || isStalled ? 0 : progressPercent,
    indeterminate: false,
    detail: job.projectName,
    statusLine: isStalled
      ? 'Stalled — worker stopped. Clear to reset for reprocessing.'
      : isQueued ? 'Queued for processing' : activeStatusLine,
    statusLineRight: !isQueued && !isStalled && progressPercent > 0 ? `${progressPercent}%` : undefined,
    completedAt: 0,
    canClear: clearable && !!onClear,
    onClear: clearable ? onClear : undefined,
    canDismiss: false,
    canPause: false,
    canResume: false,
    subItems: assets.length > 0
      ? assets.map((a) => ({ key: a.id, label: a.fileName, status: a.status }))
      : undefined,
  }
}

function normalizeAlbumZip(
  job: AlbumZipJob,
  onClear?: () => void,
): UnifiedJob {
  const isPending = job.status === 'PENDING'
  const variantLabel = job.variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'

  return {
    key: `zip:${job.id}`,
    itemCount: 1,
    kind: 'zip',
    projectId: job.projectId,
    projectName: job.projectName,
    label: job.albumName,
    sublabel: variantLabel,
    detail: job.projectName,
    status: isPending ? 'queued' : 'active',
    progress: 0,
    indeterminate: !isPending,
    statusLine: isPending ? 'Queued for packaging…' : 'Building ZIP…',
    completedAt: 0,
    canClear: isPending && !!onClear,
    onClear: isPending ? onClear : undefined,
    canDismiss: false,
    canPause: false,
    canResume: false,
  }
}

function normalizeAlbumThumbnail(
  job: AlbumThumbnailJob,
  onClear?: () => void,
): UnifiedJob {
  const isPending = job.status === 'PENDING'
  const totalBytes = Number(job.totalBytes)
  const processedBytes = Number(job.processedBytes)
  const progress = totalBytes > 0
    ? Math.min(100, Math.round((processedBytes / totalBytes) * 100))
    : job.totalPhotos > 0
      ? Math.min(100, Math.round((job.processedPhotos / job.totalPhotos) * 100))
      : 0

  return {
    key: `thumbnail:${job.id}`,
    itemCount: 1,
    kind: 'thumbnail',
    projectId: job.projectId,
    projectName: job.projectName,
    label: job.albumName,
    sublabel: 'Thumbnails',
    detail: job.projectName,
    status: isPending ? 'queued' : 'active',
    progress: isPending ? 0 : Math.max(progress, 2),
    indeterminate: false,
    statusLine: isPending
      ? `Queued for thumbnails… (${job.totalPhotos} photos)`
      : `Photo ${job.processedPhotos}/${job.totalPhotos} · ${progress}%`,
    completedAt: 0,
    canClear: isPending && !!onClear,
    onClear: isPending ? onClear : undefined,
    canDismiss: false,
    canPause: false,
    canResume: false,
  }
}

function normalizeFolderRename(
  job: FolderRenameJob,
  onClear?: () => void,
): UnifiedJob {
  const isPending = job.status === 'PENDING'
  const totalBytes = Number(job.totalBytes)
  const copiedBytes = Number(job.copiedBytes)
  const progress = totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0
  const typeLabel =
    job.entityType === 'PROJECT' ? 'Project'
    : job.entityType === 'CLIENT' ? 'Client'
    : job.entityType === 'VIDEO_GROUP' ? 'Video'
    : job.entityType === 'VIDEO_VERSION' ? 'Version'
    : 'Album'

  return {
    key: `rename:${job.id}`,
    itemCount: 1,
    kind: 'rename',
    projectId: '',
    projectName: '',
    label: job.entityName,
    sublabel: `${typeLabel} rename`,
    detail: isPending ? 'Queued for rename…' : 'Copying files…',
    status: isPending ? 'queued' : 'active',
    progress: isPending ? 0 : Math.max(progress, 1),
    indeterminate: false,
    statusLine: isPending
      ? ''
      : `${formatSize(copiedBytes)} / ${totalBytes > 0 ? formatSize(totalBytes) : `${job.copiedObjects}/${job.totalObjects} files`} · ${progress}%`,
    completedAt: 0,
    canClear: isPending && !!onClear,
    onClear: isPending ? onClear : undefined,
    canDismiss: false,
    canPause: false,
    canResume: false,
  }
}

function normalizeVideoAssetPreview(job: VideoAssetPreviewJob): UnifiedJob {
  // This channel now carries the per-project UPLOADS wave (video assets moved
  // into their version's transcode composite). Progress is measured against
  // completed work so it climbs monotonically across the whole wave.
  const isProcessing = job.processingCount > 0
  const waveTotal = job.doneCount + job.totalCount
  const progress = waveTotal > 0 ? Math.round((job.doneCount / waveTotal) * 100) : 0

  return {
    key: `upload:${job.projectId}`,
    itemCount: job.totalCount,
    kind: 'upload',
    projectId: job.projectId,
    projectName: job.projectName,
    label: `${waveTotal} upload${waveTotal !== 1 ? 's' : ''}`,
    detail: job.projectName,
    status: isProcessing ? 'active' : 'queued',
    progress: isProcessing ? Math.max(progress, 5) : 0,
    indeterminate: !isProcessing,
    statusLine: !isProcessing
      ? `${job.pendingCount} queued`
      : `${job.doneCount}/${waveTotal} processed · ${progress}%`,
    completedAt: 0,
    canClear: false,
    canDismiss: false,
    canPause: false,
    canResume: false,
    // Uploads have no parent video — show just the filename (capped server-side).
    subItems: job.assets.map((a) => ({
      key: a.id,
      label: a.fileName,
      status: a.status === 'PROCESSING' ? 'active' : 'queued' as const,
    })),
  }
}

function normalizeAlbumSocial(job: AlbumSocialJob): UnifiedJob {
  const isProcessing = job.processingCount > 0

  return {
    key: `social:${job.albumId}`,
    itemCount: job.totalCount,
    kind: 'social',
    projectId: job.projectId,
    projectName: job.projectName,
    label: job.albumName,
    sublabel: 'Social Copies',
    detail: job.projectName,
    status: isProcessing ? 'active' : 'queued',
    progress: 0,
    indeterminate: !isProcessing,
    statusLine: !isProcessing
      ? `Queued for social copies… (${job.totalCount} photos)`
      : `Generating social copies… (${job.processingCount}/${job.totalCount})`,
    completedAt: 0,
    canClear: false,
    canDismiss: false,
    canPause: false,
    canResume: false,
  }
}

function normalizeCompletedServerJob(
  job: CompletedServerJob,
  onDismiss: (id: string) => void,
): UnifiedJob {
  const isError = !!job.error

  const typeLabel =
    job.type === 'processing' ? 'Processing complete'
    : job.type === 'albumZip' ? 'ZIP build complete'
    : job.type === 'albumThumbnail' ? 'Thumbnails complete'
    : job.type === 'videoAssetPreview' ? 'Uploads complete'
    : job.type === 'albumSocial' ? 'Social copies complete'
    : job.type === 'system' ? 'Background job complete'
    : 'Folder rename complete'

  const errorLabel =
    job.type === 'processing' ? 'Processing failed'
    : job.type === 'albumZip' ? 'ZIP build failed'
    : job.type === 'albumThumbnail' ? 'Thumbnails failed'
    : job.type === 'videoAssetPreview' ? 'Uploads failed'
    : job.type === 'albumSocial' ? 'Social copies failed'
    : job.type === 'system' ? 'Background job failed'
    : 'Folder rename failed'

  const kind: JobKind =
    job.type === 'processing' ? 'transcode'
    : job.type === 'albumZip' ? 'zip'
    : job.type === 'albumThumbnail' ? 'thumbnail'
    : job.type === 'videoAssetPreview' ? 'upload'
    : job.type === 'albumSocial' ? 'social'
    : job.type === 'system' ? 'system'
    : 'rename'

  // Clean project name for grouping (falls back to the sublabel up to the first ' · ').
  const cleanProjectName = job.projectName || job.sublabel.split(' · ')[0] || ''

  return {
    key: `done:${job.type}:${job.id}`,
    itemCount: job.assets?.length ?? 1,
    kind,
    projectId: job.projectId,
    projectName: cleanProjectName,
    label: job.label,
    detail: job.sublabel,
    status: isError ? 'failed' : 'done',
    progress: 100,
    indeterminate: false,
    statusLine: isError ? errorLabel : typeLabel,
    error: isError ? errorLabel : undefined,
    completedAt: job.completedAt,
    canClear: false,
    canDismiss: true,
    onDismiss: () => onDismiss(`${job.type}:${job.id}`),
    canPause: false,
    canResume: false,
    subItems: job.assets?.map((a) => ({
      key: a.id,
      label: a.fileName,
      sublabel: `${a.videoName}${a.versionLabel ? ` ${a.versionLabel}` : ''}`,
      status: 'done' as const,
    })),
  }
}

// ---------------------------------------------------------------------------
// Grouping by project
// ---------------------------------------------------------------------------

/** Bucket key for jobs that don't belong to a project (e.g. client folder renames). */
const MAINTENANCE_KEY = '__maintenance__'

const KIND_NOUN: Record<JobKind, [singular: string, plural: string]> = {
  'upload': ['upload', 'uploads'],
  'transcode': ['transcode', 'transcodes'],
  'asset-timeline': ['timeline', 'timelines'],
  'upload-timeline': ['timeline', 'timelines'],
  'zip': ['ZIP', 'ZIPs'],
  'thumbnail': ['thumbnail', 'thumbnails'],
  'rename': ['rename', 'renames'],
  'asset-preview': ['preview', 'previews'],
  'social': ['social copy', 'social copies'],
  'system': ['system job', 'system jobs'],
}

function kindChip(kind: JobKind, count: number): string {
  const [singular, plural] = KIND_NOUN[kind]
  return `${count} ${count === 1 ? singular : plural}`
}

type ProjectGroup = {
  /** Bucket key — real projectId, or MAINTENANCE_KEY. */
  key: string
  /** Empty for the maintenance bucket; otherwise the navigable project id. */
  projectId: string
  name: string
  isMaintenance: boolean
  /** Active + queued jobs, active first. */
  jobs: UnifiedJob[]
  activeCount: number
  queuedCount: number
  hasActive: boolean
  /** Item count of this project's recently-failed jobs (shown as a chip while still active). */
  failedCount: number
  /** Roll-up progress 0–100. */
  progress: number
  showBar: boolean
  breakdown: { kind: JobKind; label: string }[]
  /** Finished (done/failed) jobs for this project that completed while still active — shown inline within the expanded card. */
  completedJobs: UnifiedJob[]
}

/**
 * Group active + queued jobs into one entry per project. Progress rolls up as
 * completed-items / total-items (with partial credit for in-flight jobs), using
 * `finished` to know how many of the project's items have already completed.
 */
function buildProjectGroups(activeQueued: UnifiedJob[], finished: UnifiedJob[]): ProjectGroup[] {
  const doneItemsByProject = new Map<string, number>()
  const failedItemsByProject = new Map<string, number>()
  const completedJobsByProject = new Map<string, UnifiedJob[]>()
  for (const j of finished) {
    const pid = j.projectId || MAINTENANCE_KEY
    if (j.status === 'done') doneItemsByProject.set(pid, (doneItemsByProject.get(pid) ?? 0) + j.itemCount)
    else if (j.status === 'failed') failedItemsByProject.set(pid, (failedItemsByProject.get(pid) ?? 0) + j.itemCount)
    const arr = completedJobsByProject.get(pid)
    if (arr) arr.push(j)
    else completedJobsByProject.set(pid, [j])
  }

  const byProject = new Map<string, UnifiedJob[]>()
  for (const j of activeQueued) {
    const pid = j.projectId || MAINTENANCE_KEY
    const arr = byProject.get(pid)
    if (arr) arr.push(j)
    else byProject.set(pid, [j])
  }

  const groups: ProjectGroup[] = []
  for (const [pid, jobs] of byProject) {
    jobs.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))

    const activeCount = jobs.filter((j) => j.status === 'active').length
    const queuedCount = jobs.length - activeCount
    const hasActive = activeCount > 0
    const isMaintenance = pid === MAINTENANCE_KEY

    const remainingItems = jobs.reduce((sum, j) => sum + j.itemCount, 0)
    const activeProgressItems = jobs.reduce(
      (sum, j) =>
        sum + (j.status === 'active' ? (j.itemCount * Math.min(Math.max(j.progress, 0), 100)) / 100 : 0),
      0,
    )
    const doneItems = doneItemsByProject.get(pid) ?? 0
    const totalItems = doneItems + remainingItems
    const progress = totalItems > 0 ? Math.round(((doneItems + activeProgressItems) / totalItems) * 100) : 0

    const kindCounts = new Map<JobKind, number>()
    for (const j of jobs) kindCounts.set(j.kind, (kindCounts.get(j.kind) ?? 0) + j.itemCount)

    const named = jobs.find((j) => j.projectName)?.projectName

    // Completed jobs for this project — newest first, only for projects that have active/queued work.
    const completedJobs = (completedJobsByProject.get(pid) ?? []).slice().sort((a, b) => b.completedAt - a.completedAt)

    groups.push({
      key: pid,
      projectId: isMaintenance ? '' : pid,
      name: isMaintenance ? 'Maintenance' : named || jobs[0].label || 'Project',
      isMaintenance,
      jobs,
      activeCount,
      queuedCount,
      hasActive,
      failedCount: failedItemsByProject.get(pid) ?? 0,
      progress,
      showBar: hasActive || doneItems > 0,
      breakdown: [...kindCounts.entries()].map(([kind, count]) => ({ kind, label: kindChip(kind, count) })),
      completedJobs,
    })
  }

  // Maintenance last; otherwise alphabetical for stable ordering.
  groups.sort((a, b) => (a.isMaintenance !== b.isMaintenance ? (a.isMaintenance ? 1 : -1) : a.name.localeCompare(b.name)))
  return groups
}

type FinishedGroup = {
  key: string
  projectId: string
  name: string
  isMaintenance: boolean
  /** Finished jobs (done + failed) for this project, newest first. */
  children: UnifiedJob[]
  completedAt: number
}

/** Consolidate finished jobs into one entry per project (newest first). */
function buildFinishedGroups(finished: UnifiedJob[]): FinishedGroup[] {
  const byProject = new Map<string, UnifiedJob[]>()
  for (const j of finished) {
    const pid = j.projectId || MAINTENANCE_KEY
    const arr = byProject.get(pid)
    if (arr) arr.push(j)
    else byProject.set(pid, [j])
  }

  const groups: FinishedGroup[] = []
  for (const [pid, children] of byProject) {
    children.sort((a, b) => b.completedAt - a.completedAt)
    const isMaintenance = pid === MAINTENANCE_KEY
    const named = children.find((c) => c.projectName)?.projectName
    groups.push({
      key: pid,
      projectId: isMaintenance ? '' : pid,
      name: isMaintenance ? 'Maintenance' : named || children[0].label || 'Project',
      isMaintenance,
      children,
      completedAt: Math.max(...children.map((c) => c.completedAt)),
    })
  }

  groups.sort((a, b) => b.completedAt - a.completedAt)
  return groups
}

// ---------------------------------------------------------------------------
// Project group card (active / queued) — collapsible roll-up over its jobs
// ---------------------------------------------------------------------------

function ProjectGroupCard({
  group,
  expanded,
  onToggle,
  onNavigate,
}: {
  group: ProjectGroup
  expanded: boolean
  onToggle: () => void
  onNavigate: (projectId: string) => void
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight
  const FolderIcon = group.isMaintenance ? Wrench : Folder

  return (
    <div>
      <div className="px-4 py-3 cursor-pointer hover:bg-accent/40 transition-colors" onClick={onToggle}>
        <div className="flex items-center gap-2.5">
          <Chevron className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
          <FolderIcon className={cn('w-4 h-4 flex-shrink-0', group.hasActive ? 'text-primary' : 'text-muted-foreground')} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{group.name}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {[
                group.activeCount > 0 ? `${group.activeCount} active` : null,
                group.queuedCount > 0 ? `${group.queuedCount} queued` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          {group.failedCount > 0 ? (
            <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium">
              <AlertTriangle className="w-3 h-3" />
              {group.failedCount}
            </span>
          ) : null}
          <span className="flex-shrink-0 text-xs font-medium text-muted-foreground">
            {group.showBar ? `${group.progress}%` : 'Queued'}
          </span>
        </div>

        {group.showBar ? (
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary mt-2.5">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700"
              style={{ width: `${Math.max(group.progress, group.hasActive ? 2 : 0)}%` }}
            />
          </div>
        ) : null}

        {!expanded && group.breakdown.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {group.breakdown.map((b) => (
              <span
                key={b.kind}
                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium"
              >
                {b.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="border-t border-border/50 bg-muted/10 divide-y divide-border/50">
          {group.jobs.map((job) => (
            <CompactJobRow key={job.key} job={job} onNavigate={onNavigate} />
          ))}
          {group.completedJobs.length > 0 && (
            <>
              <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60 font-medium bg-muted/20 select-none">
                Completed
              </div>
              {group.completedJobs.map((job) => (
                <CompactJobRow key={job.key} job={job} onNavigate={onNavigate} />
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Consolidated finished card — one entry per project, expandable to children
// ---------------------------------------------------------------------------

function ConsolidatedFinishedRow({
  group,
  expanded,
  onToggle,
  onNavigate,
}: {
  group: FinishedGroup
  expanded: boolean
  onToggle: () => void
  onNavigate: (projectId: string) => void
}) {
  const doneCount = group.children.filter((c) => c.status === 'done').length
  const failedCount = group.children.length - doneCount
  const Chevron = expanded ? ChevronDown : ChevronRight
  const allFailed = doneCount === 0 && failedCount > 0

  const dismissAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    for (const child of group.children) child.onDismiss?.()
  }

  return (
    <div>
      <div className="px-4 py-3 cursor-pointer hover:bg-accent/40 transition-colors" onClick={onToggle}>
        <div className="flex items-center gap-2.5">
          <Chevron className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
          {allFailed ? (
            <XCircle className="w-4 h-4 flex-shrink-0 text-destructive" />
          ) : (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{group.name}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {[
                doneCount > 0 ? `${doneCount} complete` : null,
                failedCount > 0 ? `${failedCount} failed` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissAll}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title="Dismiss all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border/50 bg-muted/10 divide-y divide-border/50">
          {group.children.map((job) => (
            <CompactJobRow key={job.key} job={job} onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RunningJobsBell() {
  const {
    uploads,
    processingJobs,
    albumZipJobs,
    albumThumbnailJobs,
    folderRenameJobs,
    videoAssetPreviewJobs,
    albumSocialJobs,
    completedServerJobs,
    totalActiveCount,
    totalActiveItems,
    pollError,
    cancelUpload,
    pauseUpload,
    resumeUpload,
    dismissUpload,
    dismissCompletedJob,
    clearRunningJob,
    setDropdownOpen,
  } = useUploadManager()

  const [open, setOpen] = useState(false)
  const [clearingJobKey, setClearingJobKey] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const router = useRouter()

  function handleNavigate(projectId: string) {
    setOpen(false)
    router.push(`/admin/projects/${projectId}`)
  }

  const handleClearJob = useCallback(
    async (target: ClearRunningJobTarget) => {
      const jobKey = `${target.type}:${target.id}`
      setClearingJobKey(jobKey)
      try {
        await clearRunningJob(target)
      } finally {
        setClearingJobKey((current) => (current === jobKey ? null : current))
      }
    },
    [clearRunningJob],
  )

  useEffect(() => {
    setDropdownOpen(open)
  }, [open, setDropdownOpen])

  // -----------------------------------------------------------------------
  // Normalize all jobs into a single UnifiedJob array, grouped by status
  // -----------------------------------------------------------------------

  const allJobs = useMemo<UnifiedJob[]>(() => {
    const jobs: UnifiedJob[] = []

    for (const u of uploads) {
      jobs.push(normalizeUpload(u, { cancel: cancelUpload, pause: pauseUpload, resume: resumeUpload, dismiss: dismissUpload }))
    }

    for (const p of processingJobs) {
      jobs.push(
        normalizeProcessing(
          p,
          p.status === 'QUEUED' || p.stalled ? () => handleClearJob({ type: 'processing', id: p.id }) : undefined,
        ),
      )
    }

    for (const z of albumZipJobs) {
      jobs.push(
        normalizeAlbumZip(
          z,
          z.status === 'PENDING' ? () => handleClearJob({ type: 'albumZip', id: z.id }) : undefined,
        ),
      )
    }

    for (const t of albumThumbnailJobs) {
      jobs.push(
        normalizeAlbumThumbnail(
          t,
          t.status === 'PENDING' ? () => handleClearJob({ type: 'albumThumbnail', id: t.id }) : undefined,
        ),
      )
    }

    for (const r of folderRenameJobs) {
      jobs.push(
        normalizeFolderRename(
          r,
          r.status === 'PENDING' ? () => handleClearJob({ type: 'folderRename', id: r.id }) : undefined,
        ),
      )
    }

    for (const a of videoAssetPreviewJobs) {
      jobs.push(normalizeVideoAssetPreview(a))
    }

    for (const s of albumSocialJobs) {
      jobs.push(normalizeAlbumSocial(s))
    }

    for (const c of completedServerJobs) {
      jobs.push(normalizeCompletedServerJob(c, dismissCompletedJob))
    }

    return jobs
  }, [
    uploads, processingJobs, albumZipJobs, albumThumbnailJobs, folderRenameJobs,
    videoAssetPreviewJobs, albumSocialJobs, completedServerJobs,
    cancelUpload, pauseUpload, resumeUpload, dismissUpload, dismissCompletedJob, handleClearJob,
  ])

  const activeAndQueued = useMemo(
    () => allJobs.filter((j) => j.status === 'active' || j.status === 'queued'),
    [allJobs],
  )
  const finishedJobs = useMemo(
    () => allJobs
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => b.completedAt - a.completedAt),
    [allJobs],
  )

  // Group active/queued work into one card per project.
  const projectGroups = useMemo(
    () => buildProjectGroups(activeAndQueued, finishedJobs),
    [activeAndQueued, finishedJobs],
  )
  const inProgressGroups = useMemo(() => projectGroups.filter((g) => g.hasActive), [projectGroups])
  const queuedGroups = useMemo(() => projectGroups.filter((g) => !g.hasActive), [projectGroups])

  // A project lives in exactly one section. Finished entries surface only once the
  // project has no active/queued work left (avoids the same project in two sections,
  // and lets re-runs reuse the same keys without a stale "complete" lingering).
  const activeProjectKeys = useMemo(
    () => new Set(projectGroups.map((g) => g.key)),
    [projectGroups],
  )
  const finishedGroups = useMemo(
    () => buildFinishedGroups(finishedJobs.filter((j) => !activeProjectKeys.has(j.projectId || MAINTENANCE_KEY))),
    [finishedJobs, activeProjectKeys],
  )

  // Expand/collapse overrides keyed by card key; absent = use the default rule.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const isExpanded = (key: string, fallback: boolean) =>
    key in expandedOverrides ? expandedOverrides[key] : fallback
  const toggleExpanded = useCallback((key: string, fallback: boolean) => {
    setExpandedOverrides((prev) => ({ ...prev, [key]: !(key in prev ? prev[key] : fallback) }))
  }, [])

  const hasAnything = activeAndQueued.length > 0 || finishedGroups.length > 0

  // -----------------------------------------------------------------------

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          window.setTimeout(() => triggerRef.current?.blur(), 0)
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="icon"
          aria-label="Running Jobs"
          title="Running Jobs"
          className="relative p-2 w-9 sm:w-10 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:border-primary/50"
        >
          <Activity className="h-4 w-4 sm:h-5 sm:w-5" />
          {(() => {
            // Prefer the per-item count (which expands grouped jobs); fall back to
            // the job count. They only differ when grouped jobs have >1 item.
            const badgeCount = Math.max(totalActiveItems, totalActiveCount)
            return badgeCount > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-[18px] text-center">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            ) : null
          })()}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="!p-0 w-[92vw] sm:w-[400px] max-w-[92vw] max-h-[70dvh] overflow-hidden data-[state=open]:!animate-none data-[state=closed]:!animate-none"
      >
        <div className="flex flex-col max-h-[70dvh]">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="text-sm font-semibold text-foreground">Running Jobs</div>
            {totalActiveCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                  </span>
                  {totalActiveCount} active
                  {totalActiveItems !== totalActiveCount ? ` · ${totalActiveItems} items` : ''}
                </span>
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {pollError ? (
              <div className="p-4 text-center">
                <div className="text-sm text-destructive">{pollError}</div>
                <div className="text-xs text-muted-foreground mt-1">Showing last known state.</div>
              </div>
            ) : null}
            {!hasAnything && !pollError ? (
              <div className="p-6 text-center text-sm text-muted-foreground">No jobs running.</div>
            ) : (
              <div>
                {inProgressGroups.length > 0 && (
                  <div>
                    <SectionHeader label="In Progress" count={inProgressGroups.length} />
                    <div className="divide-y divide-border">
                      {inProgressGroups.map((group) => {
                        const cardKey = `grp:${group.key}`
                        const fallback = group.jobs.length <= 3
                        return (
                          <ProjectGroupCard
                            key={cardKey}
                            group={group}
                            expanded={isExpanded(cardKey, fallback)}
                            onToggle={() => toggleExpanded(cardKey, fallback)}
                            onNavigate={handleNavigate}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}

                {queuedGroups.length > 0 && (
                  <div>
                    <SectionHeader label="Queued" count={queuedGroups.length} />
                    <div className="divide-y divide-border">
                      {queuedGroups.map((group) => {
                        const cardKey = `grp:${group.key}`
                        const fallback = group.jobs.length <= 3
                        return (
                          <ProjectGroupCard
                            key={cardKey}
                            group={group}
                            expanded={isExpanded(cardKey, fallback)}
                            onToggle={() => toggleExpanded(cardKey, fallback)}
                            onNavigate={handleNavigate}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}

                {finishedGroups.length > 0 && (
                  <div>
                    <SectionHeader label="Recently Finished" count={finishedGroups.length} />
                    <div className="divide-y divide-border">
                      {finishedGroups.map((group) => {
                        // A lone completion renders as its own row; multiples consolidate.
                        if (group.children.length === 1) {
                          return (
                            <JobRow key={group.children[0].key} job={group.children[0]} onNavigate={handleNavigate} />
                          )
                        }
                        const cardKey = `fin:${group.key}`
                        const fallback = group.children.length <= 3 || group.children.some((c) => c.status === 'failed')
                        return (
                          <ConsolidatedFinishedRow
                            key={cardKey}
                            group={group}
                            expanded={isExpanded(cardKey, fallback)}
                            onToggle={() => toggleExpanded(cardKey, fallback)}
                            onNavigate={handleNavigate}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
