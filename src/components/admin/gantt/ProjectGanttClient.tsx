'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarRange, Download, Pencil, Plus, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InputDialog } from '@/components/ui/input-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { computeGanttLayout } from '@/lib/gantt/layout'
import type { GanttTaskRow, ScheduleDTO } from '@/lib/gantt/types'
import GanttChart from './GanttChart'
import TaskEditorDialog, { type TaskEditorValue } from './TaskEditorDialog'
import PhaseEditorDialog, { type PhaseEditorValue } from './PhaseEditorDialog'

interface ProjectInfo {
  id: string
  title: string
  companyName: string | null
  startDate: string | null
}

export default function ProjectGanttClient({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth()
  const [schedule, setSchedule] = useState<ScheduleDTO | null>(null)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [studioName, setStudioName] = useState('Studio')
  const [headerColor, setHeaderColor] = useState<string | null>(null)
  const [headerTextMode, setHeaderTextMode] = useState<'LIGHT' | 'DARK' | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [editMode, setEditMode] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Display sizing: the chart fills the container width by default (fitScale),
  // with a user zoom multiplier on top; the container scrolls when zoomed in.
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    const el = chartContainerRef.current
    if (!el) return
    setContainerWidth(el.clientWidth) // measure immediately; observer handles resizes
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [schedule])

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false)
  const [createAnchor, setCreateAnchor] = useState('')
  const [createWeekends, setCreateWeekends] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<GanttTaskRow['task'] & { phaseId: string } | null>(null)
  const [newTaskPhaseId, setNewTaskPhaseId] = useState<string | undefined>(undefined)

  const [phaseDialogOpen, setPhaseDialogOpen] = useState(false)
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null)

  const [titleDialogOpen, setTitleDialogOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const permissions = useMemo(() => normalizeRolePermissions(user?.permissions), [user?.permissions])
  const canEdit = canDoAction(permissions, 'changeProjectSettings')

  const base = `/api/admin/projects/${id}/schedule`

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ schedule: ScheduleDTO | null; project: ProjectInfo }>(base)
      setSchedule(data.schedule)
      setProject(data.project)
      setNotFound(false)
    } catch (e: any) {
      if (String(e?.message).toLowerCase().includes('not found')) {
        setNotFound(true)
      } else {
        setError(e?.message || 'Failed to load schedule')
      }
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    load()
    apiJson<{ companyName?: string; emailHeaderColor?: string | null; emailHeaderTextMode?: string | null }>(
      '/api/branding/info'
    )
      .then((info) => {
        if (info?.companyName) setStudioName(info.companyName)
        setHeaderColor(info?.emailHeaderColor || null)
        setHeaderTextMode(info?.emailHeaderTextMode === 'DARK' ? 'DARK' : info?.emailHeaderTextMode === 'LIGHT' ? 'LIGHT' : null)
      })
      .catch(() => {})
  }, [load])

  const layout = useMemo(() => {
    if (!schedule || !project) return null
    return computeGanttLayout(schedule, {
      projectTitle: project.title,
      studioName,
      headerColor,
      headerTextMode,
    })
  }, [schedule, project, studioName, headerColor, headerTextMode])

  // Fill the container width by default; before the first measurement render
  // moderately enlarged rather than at raw layout size.
  const fitScale = useMemo(() => {
    if (!layout || containerWidth <= 0) return 1.25
    return Math.max(1, (containerWidth - 2) / layout.totalWidth)
  }, [layout, containerWidth])
  const displayScale = fitScale * zoom

  const editingPhase = useMemo(
    () => (editingPhaseId ? schedule?.phases.find((p) => p.id === editingPhaseId) ?? null : null),
    [schedule, editingPhaseId]
  )

  // --- Create flow ---

  const openCreate = () => {
    const projectStart = project?.startDate ? project.startDate.slice(0, 10) : ''
    const today = new Date().toISOString().slice(0, 10)
    setCreateAnchor(projectStart && projectStart >= today ? projectStart : today)
    setCreateWeekends(false)
    setCreateError(null)
    setCreateOpen(true)
  }

  const handleCreate = async (fromTemplate: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(createAnchor)) {
      setCreateError('Pick a start date first')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const data = await apiPost<{ schedule: ScheduleDTO }>(base, {
        anchorDate: createAnchor,
        includeWeekends: createWeekends,
        fromTemplate,
      })
      setSchedule(data.schedule)
      setCreateOpen(false)
      if (!fromTemplate) setEditMode(true)
    } catch (e: any) {
      setCreateError(e?.message || 'Failed to create schedule')
    } finally {
      setCreating(false)
    }
  }

  // --- Schedule-level actions ---

  const handleToggleWeekends = async (value: boolean) => {
    if (!schedule) return
    setSchedule({ ...schedule, includeWeekends: value }) // optimistic
    try {
      const data = await apiPatch<{ schedule: ScheduleDTO }>(base, { includeWeekends: value })
      setSchedule(data.schedule)
    } catch {
      load()
    }
  }

  const handleRename = async (value: string) => {
    const data = await apiPatch<{ schedule: ScheduleDTO }>(base, { title: value })
    setSchedule(data.schedule)
  }

  const handleDeleteSchedule = async () => {
    await apiDelete(base)
    setSchedule(null)
    setEditMode(false)
    setDeleteOpen(false)
  }

  const handleExport = async () => {
    if (!schedule || !project) return
    setExporting(true)
    setError(null)
    try {
      const { downloadGanttPdf } = await import('@/lib/gantt/pdf')
      const safeTitle = project.title.replace(/[\\/:*?"<>|]+/g, '-')
      await downloadGanttPdf(
        schedule,
        { projectTitle: project.title, studioName, headerColor, headerTextMode },
        `${safeTitle} - Production Schedule.pdf`
      )
    } catch (e: any) {
      setError(e?.message || 'Failed to export PDF')
    } finally {
      setExporting(false)
    }
  }

  // --- Task / phase actions ---

  const handleTaskSave = async (value: TaskEditorValue) => {
    const payload = {
      phaseId: value.phaseId,
      name: value.name.trim(),
      description: value.description.trim() || null,
      kind: value.kind,
      owner: value.owner,
      startDate: value.startDate,
      endDate: value.endDate,
      showDeadline: value.showDeadline,
    }
    if (editingTask) {
      await apiPatch(`${base}/tasks/${editingTask.id}`, payload)
    } else {
      await apiPost(`${base}/tasks`, payload)
    }
    await load()
  }

  const handleTaskDelete = async () => {
    if (!editingTask) return
    await apiDelete(`${base}/tasks/${editingTask.id}`)
    await load()
  }

  const handleTaskReorder = async (direction: 'up' | 'down') => {
    if (!editingTask) return
    await apiPatch(`${base}/tasks/${editingTask.id}`, { direction })
    await load()
  }

  const handlePhaseSave = async (value: PhaseEditorValue) => {
    if (editingPhase) {
      await apiPatch(`${base}/phases/${editingPhase.id}`, value)
    } else {
      await apiPost(`${base}/phases`, value)
    }
    await load()
  }

  const handlePhaseDelete = async () => {
    if (!editingPhase) return
    await apiDelete(`${base}/phases/${editingPhase.id}`)
    await load()
  }

  const handlePhaseReorder = async (direction: 'up' | 'down') => {
    if (!editingPhase) return
    await apiPatch(`${base}/phases/${editingPhase.id}`, { direction })
    await load()
  }

  // --- Render ---

  if (authLoading || loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading schedule…</p>
      </div>
    )
  }

  if (notFound || (!project && !schedule)) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">{error || 'Project not found'}</p>
          <Link href="/admin/projects">
            <Button>Back to Projects</Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <Link href={`/admin/projects/${id}`}>
              <Button variant="ghost" size="default" className="justify-start px-3 mb-2">
                <ArrowLeft className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Back to Project</span>
                <span className="sm:hidden">Back</span>
              </Button>
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold">Production Schedule</h1>
            {project && <p className="text-muted-foreground mt-1">{project.title}</p>}
          </div>
        </div>

        {error && (
          <Card className="mb-4">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {!schedule ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarRange className="w-5 h-5" />
                No schedule yet
              </CardTitle>
              <CardDescription>
                Build a production timeline for this project — phases, tasks, milestones and client
                review windows — and export it as a branded PDF for the client.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canEdit ? (
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create schedule
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  You don&apos;t have permission to create a schedule for this project.
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="mb-4">
              <CardContent className="p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-3 mr-auto">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="gantt-weekends" className="text-sm text-muted-foreground">
                        Show weekends
                      </Label>
                      <Switch
                        id="gantt-weekends"
                        checked={schedule.includeWeekends}
                        onCheckedChange={canEdit ? handleToggleWeekends : undefined}
                        disabled={!canEdit}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="px-2"
                        onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
                        disabled={zoom <= 0.5}
                        aria-label="Zoom out"
                      >
                        <ZoomOut className="w-4 h-4" />
                      </Button>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground w-12 text-center tabular-nums hover:text-foreground"
                        onClick={() => setZoom(1)}
                        title="Reset zoom"
                      >
                        {Math.round(zoom * 100)}%
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="px-2"
                        onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
                        disabled={zoom >= 3}
                        aria-label="Zoom in"
                      >
                        <ZoomIn className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {canEdit && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setTitleDialogOpen(true)}>
                        <Pencil className="w-4 h-4 mr-2" />
                        Rename
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingPhaseId(null)
                          setPhaseDialogOpen(true)
                        }}
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add phase
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={schedule.phases.length === 0}
                        onClick={() => {
                          setEditingTask(null)
                          setNewTaskPhaseId(schedule.phases[0]?.id)
                          setTaskDialogOpen(true)
                        }}
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add task
                      </Button>
                      <Button
                        variant={editMode ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setEditMode((v) => !v)}
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        {editMode ? 'Done editing' : 'Edit'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
                        <Trash2 className="w-4 h-4 mr-2 text-destructive" />
                        Delete
                      </Button>
                    </>
                  )}

                  <Button size="sm" onClick={handleExport} disabled={exporting || !layout}>
                    <Download className="w-4 h-4 mr-2" />
                    {exporting ? 'Exporting…' : 'Export PDF'}
                  </Button>
                </div>
                {editMode && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Edit mode: click a task row or phase header in the chart to edit it.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-2 sm:p-4">
                {layout && (
                  <div ref={chartContainerRef} className="rounded-md border border-border overflow-auto max-h-[75vh]">
                    <GanttChart
                      layout={layout}
                      scale={displayScale}
                      editable={editMode && canEdit}
                      onTaskClick={(row) => {
                        const phase = schedule.phases.find((p) => p.tasks.some((t) => t.id === row.task.id))
                        if (!phase) return
                        setEditingTask({ ...row.task, phaseId: phase.id })
                        setTaskDialogOpen(true)
                      }}
                      onPhaseClick={(phaseId) => {
                        setEditingPhaseId(phaseId)
                        setPhaseDialogOpen(true)
                      }}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create production schedule</DialogTitle>
            <DialogDescription>
              Seed a standard video-production timeline anchored to a start date, or start blank.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gantt-anchor">Start date (day 0)</Label>
              <Input
                id="gantt-anchor"
                type="date"
                value={createAnchor}
                onChange={(e) => setCreateAnchor(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="gantt-create-weekends" checked={createWeekends} onCheckedChange={setCreateWeekends} />
              <Label htmlFor="gantt-create-weekends" className="text-sm">
                Include weekends (for weekend shoots)
              </Label>
            </div>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => handleCreate(false)} disabled={creating}>
              Start blank
            </Button>
            <Button onClick={() => handleCreate(true)} disabled={creating}>
              {creating ? 'Creating…' : 'Create from template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editors */}
      {schedule && (
        <TaskEditorDialog
          open={taskDialogOpen}
          onOpenChange={setTaskDialogOpen}
          schedule={schedule}
          task={editingTask}
          defaultPhaseId={newTaskPhaseId}
          onSave={handleTaskSave}
          onDelete={editingTask ? handleTaskDelete : undefined}
          onReorder={editingTask ? handleTaskReorder : undefined}
        />
      )}
      <PhaseEditorDialog
        open={phaseDialogOpen}
        onOpenChange={setPhaseDialogOpen}
        phase={editingPhase}
        onSave={handlePhaseSave}
        onDelete={editingPhase ? handlePhaseDelete : undefined}
        onReorder={editingPhase ? handlePhaseReorder : undefined}
      />

      <InputDialog
        open={titleDialogOpen}
        onOpenChange={setTitleDialogOpen}
        title="Rename schedule"
        label="Title shown in the chart header (leave empty for the default)"
        defaultValue={schedule?.title || ''}
        placeholder={project ? `${project.title} — Production Schedule` : ''}
        confirmLabel="Save"
        allowEmpty
        onConfirm={handleRename}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete schedule?"
        description="This deletes the whole production schedule for this project, including all phases and tasks. You can re-create it from the template afterwards."
        confirmLabel="Delete schedule"
        onConfirm={handleDeleteSchedule}
      />
    </div>
  )
}
