'use client'

import { useEffect, useRef, useState } from 'react'
import { Activity, CheckCircle2, Cloud, FileArchive, FolderSync, ImageIcon, Loader2, Pause, Play, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getProcessingPhaseLabel } from '@/lib/video-processing-phase'
import { useUploadManager, type UploadJob, type ProcessingJob, type AlbumZipJob, type AlbumThumbnailJob, type CompletedServerJob, type FolderRenameJob, type ClearRunningJobTarget } from '@/components/UploadManagerProvider'
import { useRouter } from 'next/navigation'

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

function formatEta(job: UploadJob): string | null {
  if (job.status !== 'uploading' || job.speed <= 0 || job.progress >= 100) return null
  const remainingBytes = job.fileSize * (1 - job.progress / 100)
  const eta = Math.ceil(remainingBytes / (job.speed * 1024 * 1024))
  if (eta <= 0) return '<1s'
  if (eta < 60) return `${eta}s`
  const mins = Math.floor(eta / 60)
  const secs = eta % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

function VideoNameWithLabel({
  videoName,
  versionLabel,
}: {
  videoName: string
  versionLabel?: string | null
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <div className="min-w-0 truncate text-sm font-medium text-foreground">{videoName}</div>
      {versionLabel ? (
        <div className="max-w-[45%] truncate text-[11px] text-muted-foreground">{versionLabel}</div>
      ) : null}
    </div>
  )
}

function ClearQueuedJobButton({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
      className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
      title="Clear queued job"
      aria-label="Clear queued job"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UploadJobRow({ job, onNavigate }: { job: UploadJob; onNavigate: (projectId: string) => void }) {
  const { cancelUpload, pauseUpload, resumeUpload, dismissUpload } = useUploadManager()
  const eta = formatEta(job)
  const visibleProgress = job.status === 'success' ? 100 : Math.min(job.progress, 99)

  return (
    <div
      className="px-4 py-3 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <VideoNameWithLabel videoName={job.videoName} versionLabel={job.versionLabel} />
          <div className="text-[11px] text-muted-foreground truncate">
            {job.fileName} · {formatSize(job.fileSize)}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {job.status === 'uploading' && (
            <button
              type="button"
              onClick={() => pauseUpload(job.id)}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Pause upload"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type="button"
              onClick={() => resumeUpload(job.id)}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Resume upload"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {(job.status === 'queued' || job.status === 'uploading' || job.status === 'paused') && (
            <button
              type="button"
              onClick={() => cancelUpload(job.id)}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Cancel upload"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {(job.status === 'success' || job.status === 'error') && (
            <button
              type="button"
              onClick={() => dismissUpload(job.id)}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(job.status === 'uploading' || job.status === 'paused' || job.status === 'queued') && (
        <div className="space-y-1">
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                job.status === 'paused' ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${Math.max(visibleProgress, job.status === 'queued' ? 0 : 1)}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>
              {job.status === 'queued'
                ? 'Waiting in queue…'
                : job.status === 'paused'
                  ? 'Paused'
                  : job.speed > 0
                    ? `${job.speed} MB/s`
                    : 'Starting…'}
            </span>
            <span>
              {job.status === 'queued' ? '' : `${visibleProgress}%`}
              {eta ? ` · ${eta}` : ''}
            </span>
          </div>
        </div>
      )}

      {job.status === 'success' && (
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Upload complete
        </div>
      )}

      {job.status === 'error' && (
        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
          <XCircle className="w-3.5 h-3.5" />
          <span className="truncate">{job.error || 'Upload failed'}</span>
        </div>
      )}
    </div>
  )
}

function ProcessingJobRow({
  job,
  onNavigate,
  onClear,
  clearDisabled,
}: {
  job: ProcessingJob
  onNavigate: (projectId: string) => void
  onClear?: () => void
  clearDisabled?: boolean
}) {
  const rawProgress = job.processingProgress ?? 0
  const progressPercent = Math.min(
    Math.round(rawProgress <= 1 ? rawProgress * 100 : rawProgress),
    100,
  )
  const phaseLabel = getProcessingPhaseLabel(job.processingPhase)

  // Thread allocation badge: e.g. "(4/8 threads)"
  const threadBadge =
    job.allocatedThreads && job.threadBudget
      ? ` (${job.allocatedThreads}/${job.threadBudget} threads)`
      : ''

  return (
    <div
      className="relative px-4 py-3 pr-10 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
      {job.status === 'QUEUED' && onClear ? <ClearQueuedJobButton onClick={onClear} disabled={clearDisabled} /> : null}
      <div className="min-w-0">
        <VideoNameWithLabel videoName={job.videoName} versionLabel={job.versionLabel} />
        <div className="text-[11px] text-muted-foreground truncate">{job.projectName}</div>
      </div>

      <div className="space-y-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              job.status === 'QUEUED' ? 'bg-warning' : 'bg-primary',
            )}
            style={{ width: `${job.status === 'QUEUED' ? 100 : Math.max(progressPercent, 1)}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            {job.status === 'QUEUED' ? (
              <>Queued for processing</>
            ) : (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                {phaseLabel}
                {threadBadge && (
                  <span className="text-muted-foreground/70">{threadBadge}</span>
                )}
              </>
            )}
          </span>
          {job.status !== 'QUEUED' && progressPercent > 0 && (
            <span>{progressPercent}%</span>
          )}
        </div>
      </div>
    </div>
  )
}

function AlbumZipJobRow({
  job,
  onNavigate,
  onClear,
  clearDisabled,
}: {
  job: AlbumZipJob
  onNavigate: (projectId: string) => void
  onClear?: () => void
  clearDisabled?: boolean
}) {
  const isPending = job.status === 'PENDING'
  const variantLabel = job.variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'

  return (
    <div
      className="relative px-4 py-3 pr-10 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
      {isPending && onClear ? <ClearQueuedJobButton onClick={onClear} disabled={clearDisabled} /> : null}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">{job.albumName}</div>
          <div className="max-w-[45%] truncate text-[11px] text-muted-foreground">{variantLabel}</div>
        </div>
        <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
          <FileArchive className="w-3 h-3 flex-shrink-0" />
          {job.projectName}
        </div>
      </div>

      <div className="space-y-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              isPending ? 'bg-warning' : 'bg-primary',
            )}
            style={{ width: isPending ? '100%' : '60%' }}
          />
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {isPending ? (
            'Queued for packaging…'
          ) : (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Building ZIP…
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AlbumThumbnailJobRow({
  job,
  onNavigate,
  onClear,
  clearDisabled,
}: {
  job: AlbumThumbnailJob
  onNavigate: (projectId: string) => void
  onClear?: () => void
  clearDisabled?: boolean
}) {
  const isPending = job.status === 'PENDING'
  const totalBytes = Number(job.totalBytes)
  const processedBytes = Number(job.processedBytes)
  const progress = totalBytes > 0
    ? Math.min(100, Math.round((processedBytes / totalBytes) * 100))
    : (job.totalPhotos > 0 ? Math.min(100, Math.round((job.processedPhotos / job.totalPhotos) * 100)) : 0)

  return (
    <div
      className="relative px-4 py-3 pr-10 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
      {isPending && onClear ? <ClearQueuedJobButton onClick={onClear} disabled={clearDisabled} /> : null}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">{job.albumName}</div>
          <div className="max-w-[45%] truncate text-[11px] text-muted-foreground">Thumbnails</div>
        </div>
        <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
          <ImageIcon className="w-3 h-3 flex-shrink-0" />
          {job.projectName}
        </div>
      </div>

      <div className="space-y-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              isPending ? 'bg-warning' : 'bg-primary',
            )}
            style={{ width: isPending ? '100%' : `${Math.max(progress, 1)}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            {isPending ? (
              'Queued for thumbnails…'
            ) : (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                {job.processedPhotos}/{job.totalPhotos} photos
              </>
            )}
          </span>
          {!isPending && progress > 0 && <span>{progress}%</span>}
        </div>
      </div>
    </div>
  )
}

function FolderRenameJobRow({ job, onClear, clearDisabled }: { job: FolderRenameJob; onClear?: () => void; clearDisabled?: boolean }) {
  const isPending = job.status === 'PENDING'
  const totalBytes = Number(job.totalBytes)
  const copiedBytes = Number(job.copiedBytes)
  const progress = totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0
  const typeLabel = job.entityType === 'PROJECT' ? 'Project'
    : job.entityType === 'CLIENT' ? 'Client'
    : job.entityType === 'VIDEO_GROUP' ? 'Video'
    : 'Album'

  return (
    <div className="relative px-4 py-3 pr-10 space-y-2">
      {isPending && onClear ? <ClearQueuedJobButton onClick={onClear} disabled={clearDisabled} /> : null}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">{job.entityName}</div>
          <div className="max-w-[45%] truncate text-[11px] text-muted-foreground">{typeLabel}</div>
        </div>
        <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
          <FolderSync className="w-3 h-3 flex-shrink-0" />
          {isPending ? 'Queued for rename…' : 'Copying files…'}
        </div>
      </div>

      <div className="space-y-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              isPending ? 'bg-warning' : 'bg-primary',
            )}
            style={{ width: isPending ? '100%' : `${Math.max(progress, 1)}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            {isPending ? null : (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                {formatSize(copiedBytes)} / {totalBytes > 0 ? formatSize(totalBytes) : `${job.copiedObjects}/${job.totalObjects} files`}
              </>
            )}
          </span>
          {!isPending && progress > 0 && <span>{progress}%</span>}
        </div>
      </div>
    </div>
  )
}

function CompletedServerJobRow({
  job,
  onNavigate,
  onDismiss,
}: {
  job: CompletedServerJob
  onNavigate: (projectId: string) => void
  onDismiss: (id: string) => void
}) {
  const isError = !!job.error

  const typeLabel = isError
    ? job.type === 'processing'
      ? 'Processing failed'
      : job.type === 'albumZip'
          ? 'ZIP build failed'
          : job.type === 'albumThumbnail'
            ? 'Thumbnail generation failed'
          : 'Folder rename failed'
    : job.type === 'processing'
      ? 'Processing complete'
      : job.type === 'albumZip'
          ? 'ZIP build complete'
          : job.type === 'albumThumbnail'
            ? 'Thumbnail generation complete'
          : 'Folder rename complete'

  const TypeIcon =
    job.type === 'albumZip' ? FileArchive
    : job.type === 'albumThumbnail' ? ImageIcon
    : job.type === 'folderRename' ? FolderSync
    : Activity

  return (
    <div
      className="px-4 py-3 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">{job.label}</div>
          </div>
          <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
            <TypeIcon className="w-3 h-3 flex-shrink-0" />
            {job.sublabel}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onDismiss(`${job.type}:${job.id}`)}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {isError ? (
        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
          <XCircle className="w-3.5 h-3.5" />
          {typeLabel}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {typeLabel}
        </div>
      )}
    </div>
  )
}

export default function RunningJobsBell() {
  const {
    uploads,
    processingJobs,
    albumZipJobs,
    albumThumbnailJobs,
    folderRenameJobs,
    completedServerJobs,
    totalActiveCount,
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

  async function handleClearJob(target: ClearRunningJobTarget) {
    const jobKey = `${target.type}:${target.id}`
    setClearingJobKey(jobKey)
    try {
      await clearRunningJob(target)
    } finally {
      setClearingJobKey((current) => (current === jobKey ? null : current))
    }
  }

  useEffect(() => {
    setDropdownOpen(open)
  }, [open, setDropdownOpen])

  const activeUploads = uploads.filter(
    (u) => u.status === 'queued' || u.status === 'uploading' || u.status === 'paused',
  )
  const completedUploads = uploads
    .filter((u) => u.status === 'success')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  const failedUploads = uploads
    .filter((u) => u.status === 'error')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  const successfulServerJobs = completedServerJobs
    .filter((job) => !job.error)
    .sort((a, b) => b.completedAt - a.completedAt)
  const failedServerJobs = completedServerJobs
    .filter((job) => job.error)
    .sort((a, b) => b.completedAt - a.completedAt)
  const completedCount = completedUploads.length + successfulServerJobs.length
  const failedCount = failedUploads.length + failedServerJobs.length
  const hasAnything =
    activeUploads.length > 0 ||
    completedCount > 0 ||
    failedCount > 0 ||
    processingJobs.length > 0 ||
    albumZipJobs.length > 0 ||
    albumThumbnailJobs.length > 0 ||
    folderRenameJobs.length > 0

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          // Radix returns focus to the trigger on close; blur it so we don't
          // show a "highlight" only after closing.
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
          {totalActiveCount > 0 ? (
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
                </span>
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {!hasAnything ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No jobs running.
              </div>
            ) : (
              <div>
                {/* Active uploads */}
                {activeUploads.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Uploads ({activeUploads.length})
                    </div>
                    <div className="divide-y divide-border">
                      {activeUploads.map((job) => (
                        <UploadJobRow key={job.id} job={job} onNavigate={handleNavigate} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Album ZIP generation jobs */}
                {albumZipJobs.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Album ZIPs ({albumZipJobs.length})
                    </div>
                    <div className="divide-y divide-border">
                      {albumZipJobs.map((job) => (
                        <AlbumZipJobRow
                          key={job.id}
                          job={job}
                          onNavigate={handleNavigate}
                          clearDisabled={clearingJobKey === `albumZip:${job.id}`}
                          onClear={
                            job.status === 'PENDING'
                              ? () => handleClearJob({ type: 'albumZip', id: job.id })
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Album thumbnail jobs */}
                {albumThumbnailJobs.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Album Thumbnails ({albumThumbnailJobs.length})
                    </div>
                    <div className="divide-y divide-border">
                      {albumThumbnailJobs.map((job) => (
                        <AlbumThumbnailJobRow
                          key={job.id}
                          job={job}
                          onNavigate={handleNavigate}
                          clearDisabled={clearingJobKey === `albumThumbnail:${job.id}`}
                          onClear={
                            job.status === 'PENDING'
                              ? () => handleClearJob({ type: 'albumThumbnail', id: job.id })
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Folder rename jobs */}
                {folderRenameJobs.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Folder Renames ({folderRenameJobs.length})
                    </div>
                    <div className="divide-y divide-border">
                      {folderRenameJobs.map((job) => (
                        <FolderRenameJobRow
                          key={job.id}
                          job={job}
                          clearDisabled={clearingJobKey === `folderRename:${job.id}`}
                          onClear={
                            job.status === 'PENDING'
                              ? () => handleClearJob({ type: 'folderRename', id: job.id })
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Processing jobs */}
                {processingJobs.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Processing ({processingJobs.length})
                    </div>
                    <div className="divide-y divide-border">
                      {processingJobs.map((job) => (
                        <ProcessingJobRow
                          key={job.id}
                          job={job}
                          onNavigate={handleNavigate}
                          clearDisabled={clearingJobKey === `processing:${job.id}`}
                          onClear={
                            job.status === 'QUEUED'
                              ? () => handleClearJob({ type: 'processing', id: job.id })
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Failed jobs */}
                {failedCount > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Failed ({failedCount})
                    </div>
                    <div className="divide-y divide-border">
                      {failedUploads.map((job) => (
                        <UploadJobRow key={job.id} job={job} onNavigate={handleNavigate} />
                      ))}
                      {failedServerJobs.map((job) => (
                        <CompletedServerJobRow
                          key={`failed-${job.type}-${job.id}`}
                          job={job}
                          onNavigate={handleNavigate}
                          onDismiss={dismissCompletedJob}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Completed jobs */}
                {completedCount > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Completed ({completedCount})
                    </div>
                    <div className="divide-y divide-border">
                      {completedUploads.map((job) => (
                        <UploadJobRow key={job.id} job={job} onNavigate={handleNavigate} />
                      ))}
                      {successfulServerJobs.map((job) => (
                        <CompletedServerJobRow
                          key={`done-${job.type}-${job.id}`}
                          job={job}
                          onNavigate={handleNavigate}
                          onDismiss={dismissCompletedJob}
                        />
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
