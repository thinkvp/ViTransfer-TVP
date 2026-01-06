'use client'

import { useMemo } from 'react'
import { Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { PROJECT_STATUS_OPTIONS, projectStatusLabel, type ProjectStatus } from '@/lib/project-status'

type Props = {
  value: ProjectStatus[]
  onChange: (next: ProjectStatus[]) => void
  title?: string
  className?: string
}

export default function StatusFilterButton({ value, onChange, title = 'Filter statuses', className }: Props) {
  const allStatuses = useMemo(() => PROJECT_STATUS_OPTIONS.map((s) => s.value), [])
  const selected = new Set(value)
  const isActive = value.length > 0 && value.length < allStatuses.length

  const toggle = (status: ProjectStatus) => {
    const next = new Set(value)
    if (next.has(status)) next.delete(status)
    else next.add(status)

    // Keep ordering stable and consistent
    const ordered = allStatuses.filter((s) => next.has(s))
    onChange(ordered)
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={isActive ? 'secondary' : 'ghost'}
          size="sm"
          className={cn(
            'text-muted-foreground hover:text-foreground',
            isActive && 'text-foreground border border-primary/30',
            className
          )}
          title={title}
        >
          <Filter className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Filter statuses</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {PROJECT_STATUS_OPTIONS.map((s) => {
            const isSelected = selected.has(s.value)
            return (
              <Button
                key={s.value}
                type="button"
                variant={isSelected ? 'secondary' : 'outline'}
                size="sm"
                className={cn('justify-start', isSelected && 'border-primary/30')}
                onClick={() => toggle(s.value)}
              >
                {projectStatusLabel(s.value)}
              </Button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Select one or more statuses to display.
        </p>
      </DialogContent>
    </Dialog>
  )
}
