'use client'

import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  PROJECT_STATUS_OPTIONS,
  projectStatusBadgeClass,
  projectStatusLabel,
  type ProjectStatus,
} from '@/lib/project-status'

interface ProjectStatusPickerProps {
  value: string
  onChange: (nextStatus: ProjectStatus) => Promise<void> | void
  canApprove?: boolean
  disabled?: boolean
  className?: string
  stopPropagation?: boolean
}

export default function ProjectStatusPicker({
  value,
  onChange,
  canApprove,
  disabled,
  className,
  stopPropagation,
}: ProjectStatusPickerProps) {
  const [open, setOpen] = useState(false)

  const normalizedValue = useMemo(() => String(value || ''), [value])

  const approvedDisabled = normalizedValue !== 'APPROVED' && canApprove !== true

  const setStatus = async (status: ProjectStatus) => {
    await onChange(status)
    setOpen(false)
  }

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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set project status:</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            {PROJECT_STATUS_OPTIONS.map((opt) => {
              const isApproved = opt.value === 'APPROVED'
              const isShareOnly = opt.value === 'SHARE_ONLY'
              const isClosed = opt.value === 'CLOSED'
              const isSelected = normalizedValue === opt.value

              const isDisabled =
                disabled ||
                (isApproved ? approvedDisabled : false)

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
                      void setStatus(opt.value)
                    }}
                    disabled={isDisabled}
                    title={
                      isApproved && approvedDisabled
                        ? 'Approve one version of each video first'
                        : undefined
                    }
                  >
                    {opt.label}
                  </Button>

                  {isApproved && (
                    <p className="text-xs text-muted-foreground mt-1 px-1">
                      Approve one version of each video to enable project approval
                    </p>
                  )}

                  {isShareOnly && (
                    <p className="text-xs text-muted-foreground mt-1 px-1">
                      Comments &amp; version selection will be hidden.
                    </p>
                  )}

                  {isClosed && (
                    <p className="text-xs text-muted-foreground mt-1 px-1">
                      The external share link will no longer be accessible
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
