'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, MessageSquare, Plus } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { formatDate } from '@/lib/utils'
import { CardDialog, type KanbanCardData, type KanbanColumnData, type KanbanUser } from '@/components/KanbanBoard'

type TaskMember = {
  userId: string
  receiveNotifications?: boolean
  user: {
    id: string
    name: string | null
    email: string
    displayColor: string | null
    avatarPath?: string | null
  }
}

type TaskCard = {
  id: string
  title: string
  description: string | null
  dueDate: string | null
  position: number
  columnId: string
  projectId: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  members: TaskMember[]
  column: { id: string; name: string; color: string | null; position: number }
  project: { id: string; title: string } | null
  createdBy: { id: string; name: string | null; email: string } | null
  _count: { comments: number }
}

export function ProjectTasks({
  projectId,
  projectTitle,
  clientId,
  clientName,
  canEdit,
}: {
  projectId: string
  projectTitle?: string | null
  clientId?: string | null
  clientName?: string | null
  canEdit?: boolean
}) {
  const [tasks, setTasks] = useState<TaskCard[]>([])
  const [loading, setLoading] = useState(true)
  const [editingTask, setEditingTask] = useState<KanbanCardData | null>(null)
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [boardColumns, setBoardColumns] = useState<KanbanColumnData[]>([])
  const [boardUsers, setBoardUsers] = useState<KanbanUser[]>([])
  const [boardProjects, setBoardProjects] = useState<Array<{ id: string; title: string }>>([])
  const boardLoadedRef = useRef(false)
  const boardColumnsRef = useRef<KanbanColumnData[]>([])
  const boardProjectsRef = useRef<Array<{ id: string; title: string }>>([])

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/kanban/project-tasks?projectId=${encodeURIComponent(projectId)}`)
      if (res.ok) {
        const data = await res.json()
        setTasks(data.tasks || [])
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  const loadBoardData = useCallback(async () => {
    if (boardLoadedRef.current) return
    try {
      const [colRes, userRes, projRes] = await Promise.allSettled([
        apiFetch('/api/kanban'),
        apiFetch('/api/kanban/users'),
        apiFetch('/api/projects?all=true&limit=500'),
      ])
      let loadedColumns = false

      if (colRes.status === 'fulfilled' && colRes.value.ok) {
        const data = await colRes.value.json()
        const cols = data.columns || []
        boardColumnsRef.current = cols
        setBoardColumns(cols)
        loadedColumns = cols.length > 0
      }

      if (userRes.status === 'fulfilled' && userRes.value.ok) {
        const data = await userRes.value.json()
        const list = (data.users || data || []) as any[]
        setBoardUsers(list.map((u: any) => ({
          id: u.id,
          name: u.name,
          email: u.email ?? null,
          displayColor: u.displayColor ?? null,
          avatarPath: u.avatarPath ?? null,
        })))
      }

      let projs: Array<{ id: string; title: string }> = []
      if (projRes.status === 'fulfilled' && projRes.value.ok) {
        const data = await projRes.value.json()
        const list = (data.projects || data || []) as any[]
        projs = list.map((p: any) => ({ id: p.id, title: p.title }))
      }

      if (projectId && projectTitle && !projs.some((p) => p.id === projectId)) {
        projs = [{ id: projectId, title: projectTitle }, ...projs]
      }

      boardProjectsRef.current = projs
      setBoardProjects(projs)
      boardLoadedRef.current = loadedColumns
    } catch {
      boardLoadedRef.current = false
    }
  }, [projectId, projectTitle])

  const openTask = useCallback(async (task: TaskCard) => {
    await loadBoardData()
    const cardData: KanbanCardData = {
      id: task.id,
      title: task.title,
      description: task.description,
      position: task.position,
      columnId: task.columnId,
      projectId: task.projectId,
      clientId: null,
      members: task.members.map((m) => ({
        userId: m.userId,
        receiveNotifications: m.receiveNotifications !== false,
        user: m.user,
      })),
      project: task.project,
      client: null,
      createdBy: task.createdBy ?? { id: '', name: null, email: '' },
      dueDate: task.dueDate,
      archivedAt: task.archivedAt,
      _count: task._count,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
    setEditingTask(cardData)
  }, [loadBoardData])

  const handleSaveTask = useCallback(async (data: any) => {
    if (!editingTask) return
    if (!editingTask.id) {
      // New task — POST to create
      const res = await apiFetch('/api/kanban/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        throw new Error(payload?.error || 'Failed to create task')
      }
    } else {
      // Existing task — PATCH to update
      const res = await apiFetch(`/api/kanban/cards/${editingTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        throw new Error(payload?.error || 'Failed to save task')
      }
    }
    setEditingTask(null)
    setIsAddingTask(false)
    boardLoadedRef.current = false
    await loadTasks()
  }, [editingTask, loadTasks])

  const handleAddTask = useCallback(async () => {
    await loadBoardData()
    const firstColumn = boardColumnsRef.current[0]
    if (!firstColumn) {
      window.alert('Unable to load task columns right now. Please refresh and try again.')
      return
    }
    const newCard: KanbanCardData = {
      id: '',
      title: '',
      description: null,
      position: 0,
      columnId: firstColumn.id,
      projectId,
      clientId: clientId ?? null,
      members: [],
      project: boardProjectsRef.current.find((p) => p.id === projectId) ?? (projectTitle ? { id: projectId, title: projectTitle } : null),
      client: clientId && clientName ? { id: clientId, name: clientName } : null,
      createdBy: { id: '', name: null, email: '' },
      dueDate: null,
      archivedAt: null,
      _count: { comments: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setIsAddingTask(true)
    setEditingTask(newCard)
  }, [loadBoardData, projectId, projectTitle, clientId, clientName])

  if (loading) return null

  const MAX_AVATARS = 4

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3 sm:items-center mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-base font-medium">Tasks</div>
              {tasks.length > 0 && (
                <span className="text-sm text-muted-foreground">({tasks.length})</span>
              )}
            </div>
            {canEdit && (
              <div className="flex justify-end shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleAddTask()}
                  disabled={isAddingTask}
                  aria-label="Add Task"
                >
                  <Plus className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">Add Task</span>
                </Button>
              </div>
            )}
          </div>

          {tasks.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
              No tasks added yet.
            </div>
          ) : (
            <>
              {/* Desktop header */}
              <div className="hidden md:grid md:grid-cols-[minmax(0,6fr)_1.5fr_1.5fr_1.5fr] gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
                <span>Title / Status</span>
                <span className="text-center">Comments</span>
                <span>Due Date</span>
                <span>Users</span>
              </div>

          <div className="space-y-1 mt-1">
            {tasks.map((task) => {
              const dueDate = task.dueDate ? new Date(task.dueDate) : null
              const isOverdue = dueDate ? dueDate < new Date() : false
              const isArchived = Boolean(task.archivedAt)

              return (
                <div
                  key={task.id}
                  role={isArchived ? undefined : 'button'}
                  tabIndex={isArchived ? undefined : 0}
                  className={`
                    rounded-md border bg-background p-2.5 transition-all
                    md:grid md:grid-cols-[minmax(0,6fr)_1.5fr_1.5fr_1.5fr] gap-2 md:items-center
                    ${isArchived
                      ? 'opacity-60 cursor-default'
                      : 'hover:ring-1 hover:ring-primary/30 cursor-pointer'
                    }
                  `}
                  onClick={isArchived ? undefined : () => void openTask(task)}
                  onKeyDown={isArchived ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openTask(task) } }}
                >
                  {/* Title + Status */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{task.title}</p>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-white flex-shrink-0"
                        style={{ backgroundColor: task.column.color || 'hsl(var(--muted-foreground))' }}
                      >
                        {task.column.name}
                      </span>
                      {isArchived && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground flex-shrink-0">
                          Archived
                        </span>
                      )}
                    </div>
                    {task.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
                    )}
                  </div>

                  {/* Comment count */}
                  <div className="hidden md:flex items-center justify-center mt-1.5 md:mt-0">
                    {task._count.comments > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                        <MessageSquare className="w-3.5 h-3.5" />
                        {task._count.comments}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </div>

                  {/* Due date */}
                  <div className="hidden md:block mt-1.5 md:mt-0">
                    {dueDate ? (
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          isOverdue
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <CalendarDays className="w-2.5 h-2.5" />
                        {formatDate(task.dueDate!)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </div>

                  {/* Users */}
                  <div className="hidden md:flex items-center -space-x-1 mt-1.5 md:mt-0">
                    {task.members.slice(0, MAX_AVATARS).map((m) => (
                      <InitialsAvatar
                        key={m.userId}
                        name={m.user.name}
                        email={m.user.email}
                        displayColor={m.user.displayColor}
                        avatarUrl={m.user.avatarPath ? `/api/users/${m.userId}/avatar` : null}
                        className="h-5 w-5 text-[8px] ring-2 ring-card"
                        title={m.user.name || m.user.email}
                      />
                    ))}
                    {task.members.length > MAX_AVATARS && (
                      <div className="h-5 w-5 rounded-full ring-2 ring-card bg-muted flex items-center justify-center text-[8px] font-semibold text-muted-foreground flex-shrink-0">
                        +{task.members.length - MAX_AVATARS}
                      </div>
                    )}
                  </div>

                  {/* Mobile: due date + users row */}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap md:hidden">
                    {task.members.length > 0 && (
                      <div className="flex items-center -space-x-1">
                        {task.members.slice(0, MAX_AVATARS).map((m) => (
                          <InitialsAvatar
                            key={m.userId}
                            name={m.user.name}
                            email={m.user.email}
                            displayColor={m.user.displayColor}
                            avatarUrl={m.user.avatarPath ? `/api/users/${m.userId}/avatar` : null}
                            className="h-5 w-5 text-[8px] ring-2 ring-card"
                            title={m.user.name || m.user.email}
                          />
                        ))}
                        {task.members.length > MAX_AVATARS && (
                          <div className="h-5 w-5 rounded-full ring-2 ring-card bg-muted flex items-center justify-center text-[8px] font-semibold text-muted-foreground flex-shrink-0">
                            +{task.members.length - MAX_AVATARS}
                          </div>
                        )}
                      </div>
                    )}
                    {dueDate && (
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          isOverdue
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <CalendarDays className="w-2.5 h-2.5" />
                        {formatDate(task.dueDate!)}
                      </span>
                    )}
                    {task._count.comments > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                        <MessageSquare className="w-3 h-3" />
                        {task._count.comments}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
            </>
          )}
        </CardContent>
      </Card>

      {editingTask && boardColumns.length > 0 && (
        <CardDialog
          initial={editingTask}
          columnId={editingTask.columnId}
          columns={boardColumns}
          users={boardUsers}
          projects={boardProjects}
          onSave={handleSaveTask}
          onClose={() => { setEditingTask(null); setIsAddingTask(false) }}
          isAdmin={true}
        />
      )}
    </>
  )
}

