'use client'

import { useEffect, useRef, useState } from 'react'
import { Activity, CheckCircle2, Loader2, Pause, Play, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useUploadManager, type UploadJob, type ProcessingJob } from '@/components/UploadManagerProvider'
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UploadJobRow({ job, onNavigate }: { job: UploadJob; onNavigate: (projectId: string) => void }) {
  const { cancelUpload, pauseUpload, resumeUpload, dismissUpload } = useUploadManager()
  const eta = formatEta(job)

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
              style={{ width: `${Math.max(job.progress, job.status === 'queued' ? 0 : 1)}%` }}
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
              {job.status === 'queued' ? '' : `${job.progress}%`}
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

function ProcessingJobRow({ job, onNavigate }: { job: ProcessingJob; onNavigate: (projectId: string) => void }) {
  const progressPercent = Math.min(Math.round((job.processingProgress ?? 0) * 100), 100)

  // Phase label is driven by Video.processingPhase written by the worker.
  let phaseLabel = 'Processing…'
  switch (job.processingPhase) {
    case 'transcode': phaseLabel = 'Processing previews…'; break
    case 'thumbnail': phaseLabel = 'Generating thumbnail…'; break
    case 'timeline':  phaseLabel = 'Generating timeline previews…'; break
  }

  // Thread allocation badge: e.g. "(4/8 threads)"
  const threadBadge =
    job.allocatedThreads && job.threadBudget
      ? ` (${job.allocatedThreads}/${job.threadBudget} threads)`
      : ''

  return (
    <div
      className="px-4 py-3 space-y-2 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(job.projectId)}
    >
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RunningJobsBell() {
  const { uploads, processingJobs, totalActiveCount, setDropdownOpen } = useUploadManager()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const router = useRouter()

  function handleNavigate(projectId: string) {
    setOpen(false)
    router.push(`/admin/projects/${projectId}`)
  }

  useEffect(() => {
    setDropdownOpen(open)
  }, [open, setDropdownOpen])

  const activeUploads = uploads.filter(
    (u) => u.status === 'queued' || u.status === 'uploading' || u.status === 'paused',
  )
  const finishedUploads = uploads.filter((u) => u.status === 'success' || u.status === 'error')
  const hasAnything = activeUploads.length > 0 || finishedUploads.length > 0 || processingJobs.length > 0

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

                {/* Processing jobs */}
                {processingJobs.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Processing ({processingJobs.length})
                    </div>
                    <div className="divide-y divide-border">
                      {processingJobs.map((job) => (
                        <ProcessingJobRow key={job.id} job={job} onNavigate={handleNavigate} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Finished uploads */}
                {finishedUploads.length > 0 && (
                  <div>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Recent ({finishedUploads.length})
                    </div>
                    <div className="divide-y divide-border">
                      {finishedUploads.map((job) => (
                        <UploadJobRow key={job.id} job={job} onNavigate={handleNavigate} />
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
