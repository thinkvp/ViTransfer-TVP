'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { apiJson, isReadOnlyDenial } from '@/lib/api-client'
import type { ProjectApprovalSkipReason, ProjectApprovalVideoPlan } from '@/lib/project-approval-videos'
import {
  PROJECT_STATUS_OPTIONS,
  projectStatusBadgeClass,
  projectStatusLabel,
  type ProjectStatus,
} from '@/lib/project-status'

type ApprovalPreview = ProjectApprovalVideoPlan & { canApproveVideos: boolean }

const SKIP_REASON_LABEL: Record<ProjectApprovalSkipReason, string> = {
  APPROVAL_DISABLED: 'Approval is turned off for this version',
  NEXT_VERSION_REQUESTED: 'The client has asked for a next version',
  NOT_READY: 'Still processing',
}

interface ProjectStatusPickerProps {
  /** Needed to preview which videos marking the project Approved will also approve. */
  projectId: string
  value: string
  onChange: (nextStatus: ProjectStatus) => Promise<void> | void
  disabled?: boolean
  visibleStatuses?: Array<ProjectStatus | string>
  className?: string
  stopPropagation?: boolean
}

export default function ProjectStatusPicker({
  projectId,
  value,
  onChange,
  disabled,
  visibleStatuses,
  className,
  stopPropagation,
}: ProjectStatusPickerProps) {
  const [open, setOpen] = useState(false)
  // Marking a project Approved also approves its approvable videos (server-side, see
  // project-approval-videos.ts), so that choice goes through a confirm step listing them.
  const [approvalPreview, setApprovalPreview] = useState<ApprovalPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const normalizedValue = useMemo(() => String(value || ''), [value])

  const visibleOptions = useMemo(() => {
    if (!Array.isArray(visibleStatuses) || visibleStatuses.length === 0) {
      return PROJECT_STATUS_OPTIONS
    }
    const visible = new Set(visibleStatuses.map((s) => String(s)))
    return PROJECT_STATUS_OPTIONS.filter((opt) => visible.has(opt.value))
  }, [visibleStatuses])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setApprovalPreview(null)
  }

  const setStatus = async (status: ProjectStatus) => {
    setSubmitting(true)
    try {
      await onChange(status)
    } finally {
      setSubmitting(false)
    }
    handleOpenChange(false)
  }

  const chooseStatus = async (status: ProjectStatus) => {
    if (status !== 'APPROVED' || normalizedValue === 'APPROVED') {
      await setStatus(status)
      return
    }
    setLoadingPreview(true)
    try {
      const preview = await apiJson<ApprovalPreview>(`/api/projects/${encodeURIComponent(projectId)}/approval-preview`)
      if (preview.toApprove.length === 0 && preview.notApprovable.length === 0) {
        // Every video already has an approved version (or there are none) — nothing to warn about.
        await setStatus(status)
        return
      }
      setApprovalPreview(preview)
    } catch (error) {
      if (!isReadOnlyDenial(error)) toast.error('Could not check which videos will be approved')
    } finally {
      setLoadingPreview(false)
    }
  }

  const blockedByPermission = Boolean(
    approvalPreview && approvalPreview.toApprove.length > 0 && !approvalPreview.canApproveVideos
  )

  return (
    <>
      <span
        role={disabled ? undefined : 'button'}
        tabIndex={disabled ? undefined : 0}
        title={disabled ? undefined : 'Click to set project status'}
        onPointerDownCapture={(e) => {
          if (disabled) return
          if (!stopPropagation) return
          e.preventDefault()
          e.stopPropagation()
        }}
        onMouseDownCapture={(e) => {
          if (disabled) return
          if (!stopPropagation) return
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          if (disabled) return
          if (stopPropagation) {
            e.preventDefault()
            e.stopPropagation()
          }
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key !== 'Enter' && e.key !== ' ') return
          if (stopPropagation) {
            e.preventDefault()
            e.stopPropagation()
          } else {
            e.preventDefault()
          }
          setOpen(true)
        }}
        className={cn(
          'px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
          projectStatusBadgeClass(normalizedValue),
          disabled ? '' : 'cursor-pointer select-none hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          className
        )}
      >
        {projectStatusLabel(normalizedValue)}
      </span>

      {/* Wrap Dialog in a span so React portal events (overlay clicks, empty-area
          clicks inside the modal) are stopped before they bubble through the React
          component tree to any clickable parent row. */}
      <span onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className={cn('max-w-[95vw]', approvalPreview ? 'sm:max-w-md' : 'sm:max-w-sm')}>
          {approvalPreview ? (
            <>
              <DialogHeader>
                <DialogTitle>Mark project as Approved?</DialogTitle>
                <DialogDescription>Approving the project signs off every video in it.</DialogDescription>
              </DialogHeader>

              {/* min-w-0: DialogContent is a grid, so long video names would otherwise
                  stretch the track past the dialog instead of truncating. */}
              <div className="min-w-0 space-y-4 text-sm">
                {approvalPreview.toApprove.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="font-medium text-foreground">
                      {approvalPreview.toApprove.length === 1
                        ? 'This video will also be approved, which unlocks its download for the client:'
                        : `These ${approvalPreview.toApprove.length} videos will also be approved, which unlocks their downloads for the client:`}
                    </p>
                    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2">
                      {approvalPreview.toApprove.map((video) => (
                        <li key={video.id} className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate">{video.name}</span>
                          <span className="shrink-0 text-xs font-semibold text-success">{video.versionLabel}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {approvalPreview.notApprovable.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="font-medium text-foreground">
                      {approvalPreview.notApprovable.length === 1
                        ? 'This video won’t be approved:'
                        : 'These videos won’t be approved:'}
                    </p>
                    <ul className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2">
                      {approvalPreview.notApprovable.map((video) => (
                        <li key={video.id} className="min-w-0">
                          <span className="block truncate">
                            {video.name} <span className="text-muted-foreground">· {video.versionLabel}</span>
                          </span>
                          <span className="block text-xs text-muted-foreground">{SKIP_REASON_LABEL[video.reason]}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {blockedByPermission ? (
                  <p className="text-destructive">
                    Approving videos needs the Projects Full Control permission, so you can&apos;t mark this project Approved.
                  </p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setApprovalPreview(null)} disabled={submitting}>
                  Back
                </Button>
                <Button
                  type="button"
                  variant="success"
                  onClick={() => void setStatus('APPROVED')}
                  disabled={submitting || blockedByPermission || disabled}
                >
                  {submitting ? 'Approving…' : 'Approve project'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Set project status:</DialogTitle>
              </DialogHeader>

              <div className="space-y-2">
                {visibleOptions.map((opt) => {
                  const isClosed = opt.value === 'CLOSED'
                  const isSelected = normalizedValue === opt.value

                  return (
                    <div key={opt.value}>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn(
                          'w-full justify-start',
                          projectStatusBadgeClass(opt.value),
                          isSelected && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                        )}
                        onClick={(e) => {
                          // Defensive: avoid any click-through to underlying Links when this picker
                          // is used inside a clickable card.
                          e.preventDefault()
                          e.stopPropagation()
                          void chooseStatus(opt.value)
                        }}
                        disabled={disabled || loadingPreview || submitting}
                      >
                        {opt.label}
                      </Button>

                      {isClosed && (
                        <p className="text-xs text-muted-foreground mt-1 px-1">
                          The external share link will no longer be accessible
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      </span>
    </>
  )
}
