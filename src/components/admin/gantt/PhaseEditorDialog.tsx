'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SchedulePhaseDTO } from '@/lib/gantt/types'

export interface PhaseEditorValue {
  name: string
  color: string
}

interface PhaseEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing phase when editing; null when creating. */
  phase: SchedulePhaseDTO | null
  onSave: (value: PhaseEditorValue) => Promise<void>
  onDelete?: () => Promise<void>
  onReorder?: (direction: 'up' | 'down') => Promise<void>
}

const DEFAULT_COLOR = '#7C6FD8'

export default function PhaseEditorDialog({
  open,
  onOpenChange,
  phase,
  onSave,
  onDelete,
  onReorder,
}: PhaseEditorDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)

  useEffect(() => {
    if (!open) return
    setError(null)
    setName(phase?.name || '')
    setColor(phase?.color || DEFAULT_COLOR)
  }, [open, phase])

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Phase name is required')
      return
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      setError('Colour must be a hex value like #7C6FD8')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), color })
      onOpenChange(false)
    } catch (e: any) {
      setError(e?.message || 'Failed to save phase')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
      onOpenChange(false)
    } catch (e: any) {
      setError(e?.message || 'Failed to delete phase')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{phase ? 'Edit phase' : 'Add phase'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gantt-phase-name">Name</Label>
            <Input
              id="gantt-phase-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Post-production"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gantt-phase-color">Colour</Label>
            <div className="flex items-center gap-2">
              <input
                id="gantt-phase-color"
                type="color"
                value={/^#[0-9A-Fa-f]{6}$/.test(color) ? color : DEFAULT_COLOR}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 rounded border border-input bg-transparent p-1 cursor-pointer"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
                className="w-28 font-mono"
              />
            </div>
          </div>

          {phase && phase.tasks.length > 0 && onDelete && (
            <p className="text-xs text-muted-foreground">
              Deleting this phase also deletes its {phase.tasks.length} task{phase.tasks.length === 1 ? '' : 's'}.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {phase && onDelete && (
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={busy}>
                Delete
              </Button>
            )}
            {phase && onReorder && (
              <>
                <Button variant="outline" size="sm" onClick={() => onReorder('up')} disabled={busy}>
                  Move up
                </Button>
                <Button variant="outline" size="sm" onClick={() => onReorder('down')} disabled={busy}>
                  Move down
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
