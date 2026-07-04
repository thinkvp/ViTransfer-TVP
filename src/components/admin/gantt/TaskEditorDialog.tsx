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
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ScheduleDTO, ScheduleTaskDTO, ScheduleTaskKind, ScheduleTaskOwner } from '@/lib/gantt/types'

export interface TaskEditorValue {
  phaseId: string
  name: string
  description: string
  kind: ScheduleTaskKind
  owner: ScheduleTaskOwner
  startDate: string
  endDate: string
  showDeadline: boolean
}

interface TaskEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  schedule: ScheduleDTO
  /** Existing task when editing; null when creating. */
  task: (ScheduleTaskDTO & { phaseId: string }) | null
  /** Phase preselected for new tasks. */
  defaultPhaseId?: string
  onSave: (value: TaskEditorValue) => Promise<void>
  onDelete?: () => Promise<void>
  onReorder?: (direction: 'up' | 'down') => Promise<void>
}

export default function TaskEditorDialog({
  open,
  onOpenChange,
  schedule,
  task,
  defaultPhaseId,
  onSave,
  onDelete,
  onReorder,
}: TaskEditorDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [value, setValue] = useState<TaskEditorValue>(() => emptyValue())

  function emptyValue(): TaskEditorValue {
    const today = new Date().toISOString().slice(0, 10)
    return {
      phaseId: defaultPhaseId || schedule.phases[0]?.id || '',
      name: '',
      description: '',
      kind: 'BAR',
      owner: 'STUDIO',
      startDate: today,
      endDate: today,
      showDeadline: false,
    }
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    if (task) {
      setValue({
        phaseId: task.phaseId,
        name: task.name,
        description: task.description || '',
        kind: task.kind,
        owner: task.owner,
        startDate: task.startDate,
        endDate: task.endDate,
        showDeadline: task.showDeadline,
      })
    } else {
      setValue(emptyValue())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task, defaultPhaseId])

  const set = <K extends keyof TaskEditorValue>(key: K, v: TaskEditorValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }))

  const handleSave = async () => {
    if (!value.name.trim()) {
      setError('Task name is required')
      return
    }
    const endDate = value.kind === 'MILESTONE' ? value.startDate : value.endDate
    if (endDate < value.startDate) {
      setError('End date must not be before the start date')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({ ...value, endDate })
      onOpenChange(false)
    } catch (e: any) {
      setError(e?.message || 'Failed to save task')
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
      setError(e?.message || 'Failed to delete task')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit task' : 'Add task'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gantt-task-name">Name</Label>
            <Input
              id="gantt-task-name"
              value={value.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gantt-task-desc">Description</Label>
            <Textarea
              id="gantt-task-desc"
              value={value.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Shown in small text under the task name"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Phase</Label>
              <Select value={value.phaseId} onValueChange={(v) => set('phaseId', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select phase" />
                </SelectTrigger>
                <SelectContent>
                  {schedule.phases.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={value.kind} onValueChange={(v) => set('kind', v as ScheduleTaskKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BAR">Bar (duration)</SelectItem>
                  <SelectItem value="MILESTONE">Milestone (diamond)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gantt-task-start">{value.kind === 'MILESTONE' ? 'Date' : 'Start date'}</Label>
              <Input
                id="gantt-task-start"
                type="date"
                value={value.startDate}
                onChange={(e) => set('startDate', e.target.value)}
              />
            </div>
            {value.kind === 'BAR' && (
              <div className="space-y-1.5">
                <Label htmlFor="gantt-task-end">End date</Label>
                <Input
                  id="gantt-task-end"
                  type="date"
                  value={value.endDate}
                  onChange={(e) => set('endDate', e.target.value)}
                />
              </div>
            )}
          </div>

          {value.kind === 'BAR' && (
            <div className="grid grid-cols-2 gap-3 items-end">
              <div className="space-y-1.5">
                <Label>Owner</Label>
                <Select value={value.owner} onValueChange={(v) => set('owner', v as ScheduleTaskOwner)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STUDIO">Us (solid bar)</SelectItem>
                    <SelectItem value="CLIENT">Client (striped bar)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm cursor-pointer">
                <Checkbox
                  checked={value.showDeadline}
                  onCheckedChange={(v) => set('showDeadline', v === true)}
                />
                Deadline marker at bar end
              </label>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {task && onDelete && (
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={busy}>
                Delete
              </Button>
            )}
            {task && onReorder && (
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
