'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import {
  Activity,
  CheckCircle2,
  FileArchive,
  Film,
  FolderSync,
  ImageIcon,
  Loader2,
  Pause,
  Play,
  Share2,
  Upload,
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
  progress: number
  indeterminate: boolean
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
}

// ---------------------------------------------------------------------------
// JobRow — single component for every job type
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
                className={cn(
                  'h-full rounded-full transition-all duration-700',
                  isQueued ? 'bg-warning' : 'bg-primary',
                )}
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

  const kind: JobKind =
    job.versionLabel === 'asset' ? 'asset-timeline'
    : job.versionLabel === 'upload' ? 'upload-timeline'
    : 'transcode'

  const sublabel =
    job.versionLabel && job.versionLabel !== 'asset' && job.versionLabel !== 'upload'
      ? job.versionLabel : undefined

  return {
    key: `${kind}:${job.id}`,
    kind,
    projectId: job.projectId,
    projectName: job.projectName,
    label: job.videoName,
    sublabel,
    detail: job.projectName,
    status: isQueued ? 'queued' : 'active',
    progress: isQueued ? 0 : progressPercent,
    indeterminate: false,
    statusLine: isQueued
      ? 'Queued for processing'
      : `${phaseLabel}${threadBadge}`,
    statusLineRight: !isQueued && progressPercent > 0 ? `${progressPercent}%` : undefined,
    completedAt: 0,
    canClear: isQueued && !!onClear,
    onClear: isQueued ? onClear : undefined,
    canDismiss: false,
    canPause: false,
    canResume: false,
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
  const isProcessing = job.processingCount > 0
  const progress = job.totalCount > 0 ? Math.round((job.processingCount / job.totalCount) * 100) : 0

  return {
    key: `asset-preview:${job.projectId}`,
    kind: 'asset-preview',
    projectId: job.projectId,
    projectName: job.projectName,
    label: `${job.totalCount} asset preview${job.totalCount !== 1 ? 's' : ''}`,
    detail: job.projectName,
    status: isProcessing ? 'active' : 'queued',
    progress: isProcessing ? Math.max(progress, 5) : 0,
    indeterminate: !isProcessing,
    statusLine: !isProcessing
      ? `${job.pendingCount} queued · ${job.processingCount} processing`
      : `${job.processingCount}/${job.totalCount} processed · ${progress}%`,
    completedAt: 0,
    canClear: false,
    canDismiss: false,
    canPause: false,
    canResume: false,
    subItems: job.assets.map((a) => ({
      key: a.id,
      label: a.fileName,
      sublabel: `${a.videoName}${a.versionLabel ? ` ${a.versionLabel}` : ''}`,
      status: a.status === 'PROCESSING' ? 'active' : 'queued' as const,
    })),
  }
}

function normalizeAlbumSocial(job: AlbumSocialJob): UnifiedJob {
  const isProcessing = job.processingCount > 0

  return {
    key: `social:${job.albumId}`,
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
    : job.type === 'videoAssetPreview' ? 'Asset previews complete'
    : job.type === 'albumSocial' ? 'Social copies complete'
    : 'Folder rename complete'

  const errorLabel =
    job.type === 'processing' ? 'Processing failed'
    : job.type === 'albumZip' ? 'ZIP build failed'
    : job.type === 'albumThumbnail' ? 'Thumbnails failed'
    : job.type === 'videoAssetPreview' ? 'Asset previews failed'
    : job.type === 'albumSocial' ? 'Social copies failed'
    : 'Folder rename failed'

  const kind: JobKind =
    job.type === 'processing' ? 'transcode'
    : job.type === 'albumZip' ? 'zip'
    : job.type === 'albumThumbnail' ? 'thumbnail'
    : job.type === 'videoAssetPreview' ? 'asset-preview'
    : job.type === 'albumSocial' ? 'social'
    : 'rename'

  return {
    key: `done:${job.type}:${job.id}`,
    kind,
    projectId: job.projectId,
    projectName: job.sublabel,
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
          p.status === 'QUEUED' ? () => handleClearJob({ type: 'processing', id: p.id }) : undefined,
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

  const activeJobs = useMemo(
    () => allJobs.filter((j) => j.status === 'active'),
    [allJobs],
  )
  const queuedJobs = useMemo(
    () => allJobs.filter((j) => j.status === 'queued'),
    [allJobs],
  )
  const finishedJobs = useMemo(
    () => allJobs
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => b.completedAt - a.completedAt),
    [allJobs],
  )

  const hasAnything = allJobs.length > 0

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
          {totalActiveItems > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-[18px] text-center">
              {totalActiveItems > 99 ? '99+' : totalActiveItems}
            </span>
          ) : totalActiveCount > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-[18px] text-center">
              {totalActiveCount > 99 ? '99+' : totalActiveCount}
            </span>
          ) : null}
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
                {activeJobs.length > 0 && (
                  <div>
                    <SectionHeader label="In Progress" count={activeJobs.length} />
                    <div className="divide-y divide-border">
                      {activeJobs.map((job) => (
                        <JobRow key={job.key} job={job} onNavigate={handleNavigate} />
                      ))}
                    </div>
                  </div>
                )}

                {queuedJobs.length > 0 && (
                  <div>
                    <SectionHeader label="Queued" count={queuedJobs.length} />
                    <div className="divide-y divide-border">
                      {queuedJobs.map((job) => (
                        <JobRow key={job.key} job={job} onNavigate={handleNavigate} />
                      ))}
                    </div>
                  </div>
                )}

                {finishedJobs.length > 0 && (
                  <div>
                    <SectionHeader label="Recently Finished" count={finishedJobs.length} />
                    <div className="divide-y divide-border">
                      {finishedJobs.map((job) => (
                        <JobRow key={job.key} job={job} onNavigate={handleNavigate} />
                      ))}
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
