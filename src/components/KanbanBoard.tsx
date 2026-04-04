'use client'

import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CornerDownRight,
  GripVertical,
  KanbanSquare,
  Link2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { apiJson, apiPost, apiDelete } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { formatDate, formatDateTime } from '@/lib/utils'
import { fetchClientOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'

// ---------- Types ----------

export type KanbanUser = {
  id: string
  name: string | null
  email?: string | null
  displayColor: string | null
  avatarPath?: string | null
}

export type KanbanProject = {
  id: string
  title: string
}

export type KanbanClient = {
  id: string
  name: string
}

export type KanbanMember = {
  userId: string
  receiveNotifications?: boolean
  user: KanbanUser
}

export type KanbanCardData = {
  id: string
  title: string
  description: string | null
  position: number
  columnId: string
  projectId: string | null
  clientId: string | null
  members: KanbanMember[]
  project: KanbanProject | null
  client: KanbanClient | null
  createdBy: { id: string; name: string | null; email: string }
  dueDate: string | null
  archivedAt?: string | null
  _count?: { comments: number }
  createdAt: string
  updatedAt: string
}

export type KanbanColumnData = {
  id: string
  name: string
  position: number
  color: string | null
  cards: KanbanCardData[]
}

type DragState = {
  cardId: string
  sourceColumnId: string
} | null

type ColumnDragState = {
  columnId: string
  startX: number
} | null

type TaskComment = {
  id: string
  cardId: string
  userId: string | null
  parentId: string | null
  content: string
  createdAt: string
  updatedAt: string
  authorName: string
  displayColor: string | null
  avatarUrl: string | null
  replies: TaskComment[]
}

// ---------- Color presets for columns ----------

const COLUMN_COLORS = [
  { label: 'None', value: '' },
  { label: 'Blue', value: '#3B82F6' },
  { label: 'Green', value: '#22C55E' },
  { label: 'Yellow', value: '#EAB308' },
  { label: 'Orange', value: '#F97316' },
  { label: 'Red', value: '#EF4444' },
  { label: 'Purple', value: '#A855F7' },
  { label: 'Pink', value: '#EC4899' },
  { label: 'Teal', value: '#14B8A6' },
]

// ---------- Main Component ----------

export default function KanbanBoard({
  projects,
  onBoardChanged,
}: {
  projects: Array<{ id: string; title: string }>
  onBoardChanged?: () => void
}) {
  const { user } = useAuth()
  const isAdmin = user?.isSystemAdmin === true

  const [columns, setColumns] = useState<KanbanColumnData[]>([])
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<KanbanUser[]>([])

  // Drag state (cards)
  const [dragState, setDragState] = useState<DragState>(null)
  const [dropTarget, setDropTarget] = useState<{ columnId: string; position: number } | null>(null)

  // Column drag state
  const [columnsLocked, setColumnsLocked] = useState(true)
  const [columnDragState, setColumnDragState] = useState<ColumnDragState>(null)
  const [columnDropTarget, setColumnDropTarget] = useState<string | null>(null)

  // Dialogs
  const [showAddColumn, setShowAddColumn] = useState(false)
  const [editColumn, setEditColumn] = useState<KanbanColumnData | null>(null)
  const [showAddCard, setShowAddCard] = useState<string | null>(null) // columnId
  const [editCard, setEditCard] = useState<KanbanCardData | null>(null)
  const [deleteColumn, setDeleteColumn] = useState<KanbanColumnData | null>(null)
  const [deleteCard, setDeleteCard] = useState<KanbanCardData | null>(null)

  // Archive
  const [showArchived, setShowArchived] = useState(false)

  // ---------- Data loading ----------

  const loadKanban = useCallback(async () => {
    try {
      const res = await apiFetch('/api/kanban')
      if (!res.ok) throw new Error('Failed to load kanban')
      const data = await res.json()
      setColumns(data.columns || [])
    } catch {
      setColumns([])
    } finally {
      setLoading(false)
    }
  }, [])

  const loadUsers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/kanban/users')
      if (res.ok) {
        const data = await res.json()
        const list = (data.users || data || []) as any[]
        setUsers(
          list.map((u: any) => ({
            id: u.id,
            name: u.name,
            email: u.email ?? null,
            displayColor: u.displayColor ?? null,
            avatarPath: u.avatarPath ?? null,
          }))
        )
      }
    } catch {
      // Non-critical
    }
  }, [])

  useEffect(() => {
    loadKanban()
    loadUsers()
  }, [loadKanban, loadUsers])

  const notifyBoardChanged = useCallback(() => {
    onBoardChanged?.()
  }, [onBoardChanged])

  // ---------- Column CRUD ----------

  const handleAddColumn = async (name: string, color: string | null) => {
    const res = await apiFetch('/api/kanban/columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: color || null }),
    })
    if (res.ok) {
      setShowAddColumn(false)
      await loadKanban()
    }
  }

  const handleEditColumn = async (id: string, name: string, color: string | null) => {
    const res = await apiFetch(`/api/kanban/columns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: color || null }),
    })
    if (res.ok) {
      setEditColumn(null)
      await loadKanban()
    }
  }

  const handleDeleteColumn = async (id: string) => {
    const res = await apiFetch(`/api/kanban/columns/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setDeleteColumn(null)
      await loadKanban()
      notifyBoardChanged()
    }
  }

  const handleMoveColumn = async (columnId: string, newPosition: number) => {
    const res = await apiFetch(`/api/kanban/columns/${columnId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: newPosition }),
    })
    if (res.ok) {
      await loadKanban()
    }
  }

  // ---------- Card CRUD ----------

  const handleAddCard = async (data: {
    title: string
    description?: string | null
    columnId: string
    projectId?: string | null
    memberIds?: string[]
    dueDate?: string | null
  }) => {
    const res = await apiFetch('/api/kanban/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      setShowAddCard(null)
      await loadKanban()
      notifyBoardChanged()
    }
  }

  const handleEditCard = async (
    id: string,
    data: {
      title?: string
      description?: string | null
      projectId?: string | null
      clientId?: string | null
      memberIds?: string[]
      dueDate?: string | null
    }
  ) => {
    const res = await apiFetch(`/api/kanban/cards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      setEditCard(null)
      await loadKanban()
      notifyBoardChanged()
    }
  }

  const handleDeleteCard = async (id: string) => {
    const res = await apiFetch(`/api/kanban/cards/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setDeleteCard(null)
      await loadKanban()
      notifyBoardChanged()
    }
  }

  const handleArchiveCard = async (id: string) => {
    const res = await apiFetch(`/api/kanban/cards/${id}/archive`, { method: 'POST' })
    if (res.ok) {
      await loadKanban()
      notifyBoardChanged()
    }
  }

  // ---------- Card Drag & Drop ----------

  const handleMoveCard = async (cardId: string, targetColumnId: string, targetPosition: number) => {
    const res = await apiFetch(`/api/kanban/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: targetColumnId, position: targetPosition }),
    })
    if (res.ok) {
      await loadKanban()
      notifyBoardChanged()
    }
  }

  const onDragStart = (e: React.DragEvent, cardId: string, sourceColumnId: string) => {
    setDragState({ cardId, sourceColumnId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cardId)
  }

  const onDragOver = (e: React.DragEvent, columnId: string, position: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget({ columnId, position })
  }

  const onDragLeave = () => {
    setDropTarget(null)
  }

  const onDrop = async (e: React.DragEvent, columnId: string, position: number) => {
    e.preventDefault()
    if (!dragState) return

    setDragState(null)
    setDropTarget(null)

    await handleMoveCard(dragState.cardId, columnId, position)
  }

  const onDragEnd = () => {
    setDragState(null)
    setDropTarget(null)
  }

  // ---------- Column Drag & Drop ----------

  const onColumnDragStart = (e: React.DragEvent, columnId: string) => {
    if (columnsLocked) { e.preventDefault(); return }
    setColumnDragState({ columnId, startX: e.clientX })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `col:${columnId}`)
  }

  const onColumnDragOver = (e: React.DragEvent, columnId: string) => {
    if (!columnDragState) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setColumnDropTarget(columnId)
  }

  const onColumnDrop = async (e: React.DragEvent, targetColumnId: string) => {
    e.preventDefault()
    if (!columnDragState || columnDragState.columnId === targetColumnId) {
      setColumnDragState(null)
      setColumnDropTarget(null)
      return
    }
    const targetCol = columns.find((c) => c.id === targetColumnId)
    if (!targetCol) { setColumnDragState(null); setColumnDropTarget(null); return }

    setColumnDragState(null)
    setColumnDropTarget(null)
    await handleMoveColumn(columnDragState.columnId, targetCol.position)
  }

  const onColumnDragEnd = () => {
    setColumnDragState(null)
    setColumnDropTarget(null)
  }

  // ---------- Open card by ID (for external callers like calendar) ----------

  const openCardById = useCallback((cardId: string) => {
    for (const col of columns) {
      const card = col.cards.find((c) => c.id === cardId)
      if (card) {
        setEditCard(card)
        return
      }
    }
  }, [columns])

  // Expose for parent to call
  useEffect(() => {
    if (typeof window !== 'undefined') (window as any).__kanbanOpenCard = openCardById
    return () => {
      if (typeof window !== 'undefined') delete (window as any).__kanbanOpenCard
    }
  }, [openCardById])

  // ---------- Render ----------

  if (loading) {
    return (
      <Card className="mt-4">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <KanbanSquare className="w-5 h-5" />
            <h2 className="text-base font-semibold">Task Board</h2>
          </div>
          <p className="text-sm text-muted-foreground">Loading tasks...</p>
        </CardContent>
      </Card>
    )
  }

  if (columns.length === 0 && !isAdmin) {
    return null // Nothing to show for non-admins when no columns exist
  }

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <KanbanSquare className="w-5 h-5" />
              <h2 className="text-base font-semibold">Task Board</h2>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`w-8 h-8 ${showArchived ? 'text-primary' : ''}`}
                  title={showArchived ? 'Back to board' : 'View archived tasks'}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Archive className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8"
                  title={columnsLocked ? 'Unlock column reorder' : 'Lock column order'}
                  onClick={() => setColumnsLocked((v) => !v)}
                >
                  {columnsLocked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={() => setShowAddColumn(true)} aria-label="Add column" title="Add column" className="sm:w-auto sm:h-auto sm:px-3 sm:py-1.5">
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline sm:ml-1 text-sm">Add Column</span>
                </Button>
              </div>
            )}
          </div>

          {showArchived ? (
            <ArchivedView
              onUnarchive={async (id) => {
                const res = await apiFetch(`/api/kanban/cards/${id}/archive`, { method: 'DELETE' })
                if (res.ok) {
                  await loadKanban()
                  notifyBoardChanged()
                }
              }}
              onDelete={(card) => setDeleteCard(card)}
            />
          ) : columns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No columns yet. Add a column to get started.
            </p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
              {columns.map((col) => (
                <KanbanColumnView
                  key={col.id}
                  column={col}
                  isAdmin={isAdmin}
                  dragState={dragState}
                  dropTarget={dropTarget}
                  columnsLocked={columnsLocked}
                  stretch={columns.length < 5}
                  isColumnDragging={columnDragState?.columnId === col.id}
                  isColumnDropTarget={columnDropTarget === col.id}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  onColumnDragStart={(e) => onColumnDragStart(e, col.id)}
                  onColumnDragOver={(e) => onColumnDragOver(e, col.id)}
                  onColumnDrop={(e) => onColumnDrop(e, col.id)}
                  onColumnDragEnd={onColumnDragEnd}
                  onAddCard={() => setShowAddCard(col.id)}
                  onEditColumn={() => setEditColumn(col)}
                  onDeleteColumn={() => setDeleteColumn(col)}
                  onEditCard={setEditCard}
                  onDeleteCard={setDeleteCard}
                  onArchiveCard={(card) => handleArchiveCard(card.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Column Dialog */}
      {showAddColumn && (
        <ColumnDialog
          onSave={(name, color) => handleAddColumn(name, color)}
          onClose={() => setShowAddColumn(false)}
        />
      )}

      {/* Edit Column Dialog */}
      {editColumn && (
        <ColumnDialog
          initial={editColumn}
          onSave={(name, color) => handleEditColumn(editColumn.id, name, color)}
          onClose={() => setEditColumn(null)}
        />
      )}

      {/* Delete Column Confirmation */}
      {deleteColumn && (
        <ConfirmDeleteDialog
          title={`Delete column "${deleteColumn.name}"?`}
          description={`This will permanently delete the column and all ${deleteColumn.cards.length} card${deleteColumn.cards.length !== 1 ? 's' : ''} in it.`}
          onConfirm={() => handleDeleteColumn(deleteColumn.id)}
          onClose={() => setDeleteColumn(null)}
        />
      )}

      {/* Add Card Dialog */}
      {showAddCard && (
        <CardDialog
          columnId={showAddCard}
          columns={columns}
          users={users}
          projects={projects}
          onSave={(data) => handleAddCard(data)}
          onClose={() => setShowAddCard(null)}
          isAdmin={isAdmin}
          currentUserId={user?.id}
        />
      )}

      {/* Edit Card Dialog */}
      {editCard && (
        <CardDialog
          initial={editCard}
          columnId={editCard.columnId}
          columns={columns}
          users={users}
          projects={projects}
          onSave={(data) => handleEditCard(editCard.id, data)}
          onClose={() => setEditCard(null)}
          isAdmin={isAdmin}
          currentUserId={user?.id}
        />
      )}

      {/* Delete Card Confirmation */}
      {deleteCard && (
        <ConfirmDeleteDialog
          title={`Delete task "${deleteCard.title}"?`}
          description="This will permanently delete this task."
          onConfirm={() => handleDeleteCard(deleteCard.id)}
          onClose={() => setDeleteCard(null)}
        />
      )}
    </>
  )
}

// ---------- Column View ----------

function KanbanColumnView({
  column,
  isAdmin,
  dragState,
  dropTarget,
  columnsLocked,
  stretch,
  isColumnDragging,
  isColumnDropTarget,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDrop,
  onColumnDragEnd,
  onAddCard,
  onEditColumn,
  onDeleteColumn,
  onEditCard,
  onDeleteCard,
  onArchiveCard,
}: {
  column: KanbanColumnData
  isAdmin: boolean
  dragState: DragState
  dropTarget: { columnId: string; position: number } | null
  columnsLocked: boolean
  stretch?: boolean
  isColumnDragging: boolean
  isColumnDropTarget: boolean
  onDragStart: (e: React.DragEvent, cardId: string, columnId: string) => void
  onDragOver: (e: React.DragEvent, columnId: string, position: number) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent, columnId: string, position: number) => void
  onDragEnd: () => void
  onColumnDragStart: (e: React.DragEvent) => void
  onColumnDragOver: (e: React.DragEvent) => void
  onColumnDrop: (e: React.DragEvent) => void
  onColumnDragEnd: () => void
  onAddCard: () => void
  onEditColumn: () => void
  onDeleteColumn: () => void
  onEditCard: (card: KanbanCardData) => void
  onDeleteCard: (card: KanbanCardData) => void
  onArchiveCard: (card: KanbanCardData) => void
}) {
  const isEmpty = column.cards.length === 0
  const columnHeaderColor = column.color || undefined
  const canDragColumn = isAdmin && !columnsLocked

  return (
    <div
      draggable={canDragColumn}
      onDragStart={canDragColumn ? onColumnDragStart : undefined}
      onDragOver={canDragColumn ? onColumnDragOver : undefined}
      onDrop={canDragColumn ? onColumnDrop : undefined}
      onDragEnd={canDragColumn ? onColumnDragEnd : undefined}
      className={`
        ${stretch ? 'flex-shrink-0 w-[280px] md:w-auto md:flex-1 md:min-w-[200px]' : 'flex-shrink-0 w-[280px]'} bg-muted/70 dark:bg-muted/30 rounded-lg border transition-all
        ${isColumnDragging ? 'opacity-40 ring-2 ring-primary' : ''}
        ${isColumnDropTarget ? 'ring-2 ring-primary/50' : ''}
      `}
    >
      {/* Column header */}
      <div
        className={`flex items-center justify-between px-3 py-2 border-b rounded-t-lg ${canDragColumn ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={columnHeaderColor ? { borderTopColor: columnHeaderColor, borderTopWidth: 3 } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {canDragColumn && <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />}
          <h3 className="text-sm font-semibold truncate">{column.name}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {column.cards.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Button variant="ghost" size="icon" className="w-7 h-7" onClick={onAddCard}>
            <Plus className="w-3.5 h-3.5" />
          </Button>
          {isAdmin && !columnsLocked && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="w-7 h-7">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEditColumn}>
                  <Pencil className="w-3.5 h-3.5 mr-2" />
                  Edit Column
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={onDeleteColumn}>
                  <Trash2 className="w-3.5 h-3.5 mr-2" />
                  Delete Column
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Cards area */}
      <div
        className="p-2 min-h-[80px] space-y-2"
        onDragOver={(e) => onDragOver(e, column.id, column.cards.length)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDrop(e, column.id, column.cards.length)}
      >
        {column.cards.map((card, idx) => (
          <div key={card.id}>
            {/* Drop zone before card */}
            {dropTarget?.columnId === column.id && dropTarget.position === idx && (
              <div className="h-1 bg-primary/50 rounded-full mb-2 transition-all" />
            )}
            <KanbanCardView
              card={card}
              isAdmin={isAdmin}
              isDragging={dragState?.cardId === card.id}
              onDragStart={(e) => onDragStart(e, card.id, column.id)}
              onDragOver={(e) => onDragOver(e, column.id, idx)}
              onDragEnd={onDragEnd}
              onEdit={() => onEditCard(card)}
              onDelete={() => onDeleteCard(card)}
              onArchive={() => onArchiveCard(card)}
            />
          </div>
        ))}

        {/* Drop zone at end */}
        {isEmpty && dragState && dropTarget?.columnId === column.id && (
          <div className="h-1 bg-primary/50 rounded-full transition-all" />
        )}

        {isEmpty && !dragState && (
          <p className="text-xs text-muted-foreground text-center py-4">No cards</p>
        )}
      </div>
    </div>
  )
}

// ---------- Card View (with overlapping avatars) ----------

function KanbanCardView({
  card,
  isAdmin,
  isDragging,
  onDragStart,
  onDragOver,
  onDragEnd,
  onEdit,
  onDelete,
  onArchive,
}: {
  card: KanbanCardData
  isAdmin: boolean
  isDragging: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  onEdit: () => void
  onDelete: () => void
  onArchive: () => void
}) {
  const dueDate = card.dueDate ? new Date(card.dueDate) : null
  const isOverdue = dueDate ? dueDate < new Date() : false
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const menuJustUsed = useRef(false)
  const MAX_AVATARS = 6

  const handleMouseDown = (e: React.MouseEvent) => {
    dragStartPos.current = { x: e.clientX, y: e.clientY }
  }

  const handleClick = (e: React.MouseEvent) => {
    if (menuJustUsed.current) return
    if (dragStartPos.current) {
      const dx = Math.abs(e.clientX - dragStartPos.current.x)
      const dy = Math.abs(e.clientY - dragStartPos.current.y)
      if (dx > 5 || dy > 5) return
    }
    const target = e.target as HTMLElement
    if (target.closest('[data-card-menu]')) return
    onEdit()
  }

  const handleMenuAction = (action: () => void) => (e: Event) => {
    e.stopPropagation()
    menuJustUsed.current = true
    action()
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={`
        group relative bg-card border rounded-md p-2.5 cursor-pointer
        hover:ring-1 hover:ring-primary/30 transition-all shadow-sm
        ${isDragging ? 'opacity-40 ring-1 ring-primary' : ''}
      `}
    >
      <div className="flex items-start gap-1.5">
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50 mt-0.5 flex-shrink-0 cursor-grab active:cursor-grabbing" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight break-words">{card.title}</p>

          {card.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{card.description}</p>
          )}

          {card.client && (
            <p className="text-xs text-muted-foreground mt-1 font-medium">{card.client.name}</p>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {card.project && (
              <span className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                <Link2 className="w-2.5 h-2.5" />
                {card.project.title}
              </span>
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
                {formatDate(card.dueDate!)}
              </span>
            )}
          </div>

          {/* Overlapping user avatars + comment count */}
          <div className="flex items-center justify-between mt-2">
            {card.members && card.members.length > 0 ? (
              <div className="flex items-center -space-x-1">
                {card.members.slice(0, MAX_AVATARS).map((m) => (
                  <InitialsAvatar
                    key={m.userId}
                    name={m.user.name}
                    email={m.user.email}
                    displayColor={m.user.displayColor}
                    avatarUrl={m.user.avatarPath ? `/api/users/${m.userId}/avatar` : null}
                    className="h-6 w-6 text-[9px] ring-2 ring-card"
                    title={m.user.name || m.user.email || undefined}
                  />
                ))}
                {card.members.length > MAX_AVATARS && (
                  <div
                    className="h-6 w-6 rounded-full ring-2 ring-card bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground flex-shrink-0"
                    title={`${card.members.length - MAX_AVATARS} more`}
                  >
                    +{card.members.length - MAX_AVATARS}
                  </div>
                )}
              </div>
            ) : <span />}
            {(card._count?.comments ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <MessageSquare className="w-3 h-3" />
                {card._count!.comments}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <DropdownMenu onOpenChange={(open) => {
          if (!open) {
            menuJustUsed.current = true
            setTimeout(() => { menuJustUsed.current = false }, 300)
          }
        }}>
          <DropdownMenuTrigger asChild>
            <Button
              data-card-menu
              variant="ghost"
              size="icon"
              className="w-6 h-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="w-3 h-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={handleMenuAction(onEdit)}>
              <Pencil className="w-3.5 h-3.5 mr-2" />
              Edit
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem onSelect={handleMenuAction(onArchive)}>
                <Archive className="w-3.5 h-3.5 mr-2" />
                Archive
              </DropdownMenuItem>
            )}
            {isAdmin && (
              <DropdownMenuItem className="text-destructive" onSelect={handleMenuAction(onDelete)}>
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ---------- Column Dialog ----------

function ColumnDialog({
  initial,
  onSave,
  onClose,
}: {
  initial?: KanbanColumnData
  onSave: (name: string, color: string | null) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [color, setColor] = useState(initial?.color || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(name.trim(), color || null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit Column' : 'Add Column'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. To Do, In Progress, Done"
              maxLength={100}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Color</label>
            <div className="flex gap-1.5 mt-1">
              {COLUMN_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c.value
                      ? 'border-foreground scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{
                    backgroundColor: c.value || 'hsl(var(--muted))',
                  }}
                  title={c.label}
                  onClick={() => setColor(c.value)}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button className="w-full sm:w-auto" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" variant="default" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? 'Saving...' : initial ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Card Dialog (Two-Column Layout) ----------

export function CardDialog({
  initial,
  columnId,
  columns,
  users,
  projects,
  onSave,
  onClose,
  isAdmin = true,
  currentUserId,
}: {
  initial?: KanbanCardData
  columnId: string
  columns: KanbanColumnData[]
  users: KanbanUser[]
  projects: Array<{ id: string; title: string }>
  onSave: (data: any) => Promise<void>
  onClose: () => void
  isAdmin?: boolean
  currentUserId?: string
}) {
  const router = useRouter()
  const { user: currentUser } = useAuth()
  const [title, setTitle] = useState(initial?.title || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [memberIds, setMemberIds] = useState<string[]>(() => {
    const existing = initial?.members?.map((m) => m.userId) || []
    // Auto-select the creating user on new tasks
    if (!initial && currentUserId && !existing.includes(currentUserId)) {
      return [currentUserId, ...existing]
    }
    return existing
  })
  const [memberNotifications, setMemberNotifications] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    if (initial?.members) {
      for (const m of initial.members) {
        map[m.userId] = m.receiveNotifications !== false
      }
    }
    return map
  })
  const [projectId, setProjectId] = useState(initial?.projectId || '')
  const [editingProject, setEditingProject] = useState(!initial?.projectId)
  const [clientId, setClientId] = useState(initial?.clientId || '')
  const [editingClient, setEditingClient] = useState(!initial?.clientId)
  const [clientOptions, setClientOptions] = useState<Array<{ value: string; label: string }>>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [filteredProjectOptions, setFilteredProjectOptions] = useState<Array<{ value: string; label: string }>>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [selectedColumnId, setSelectedColumnId] = useState(columnId)
  const [dueDate, setDueDate] = useState(
    initial?.dueDate ? new Date(initial.dueDate).toISOString().slice(0, 10) : ''
  )
  const [saving, setSaving] = useState(false)

  // Load clients on mount
  useEffect(() => {
    setLoadingClients(true)
    fetchClientOptions()
      .then((list) => setClientOptions(list.map((c) => ({ value: c.id, label: c.name }))))
      .catch(() => {})
      .finally(() => setLoadingClients(false))
  }, [])

  // Load projects filtered by client when clientId changes
  useEffect(() => {
    if (!clientId) {
      setFilteredProjectOptions([])
      return
    }
    setLoadingProjects(true)
    fetchProjectOptionsForClient(clientId)
      .then((list) => setFilteredProjectOptions(list.map((p) => ({ value: p.id, label: p.title }))))
      .catch(() => setFilteredProjectOptions([]))
      .finally(() => setLoadingProjects(false))
  }, [clientId])

  // Track unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    const initTitle = initial?.title || ''
    const initDescription = initial?.description || ''
    const initMemberIds = initial?.members?.map((m) => m.userId) || []
    const initProjectId = initial?.projectId || ''
    const initClientId = initial?.clientId || ''
    const initDueDate = initial?.dueDate ? new Date(initial.dueDate).toISOString().slice(0, 10) : ''
    if (title !== initTitle) return true
    if (description !== initDescription) return true
    if (JSON.stringify([...memberIds].sort()) !== JSON.stringify([...initMemberIds].sort())) return true
    if (projectId !== initProjectId) return true
    if (clientId !== initClientId) return true
    if (selectedColumnId !== columnId) return true
    if (dueDate !== initDueDate) return true
    return false
  }, [title, description, memberIds, projectId, clientId, selectedColumnId, dueDate, initial, columnId])

  const guardedClose = useCallback(() => {
    if (hasUnsavedChanges) {
      if (!window.confirm('You have unsaved changes. Are you sure you want to close?')) return
    }
    onClose()
  }, [hasUnsavedChanges, onClose])

  // Column options for the status pill
  const columnOptions = columns.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
  }))
  const currentColumn = columnOptions.find((c) => c.id === selectedColumnId)

  const toggleMember = (userId: string) => {
    setMemberIds((prev) => {
      if (prev.includes(userId)) {
        return prev.filter((id) => id !== userId)
      }
      // Default to notifications on for new members
      setMemberNotifications((nm) => ({ ...nm, [userId]: nm[userId] ?? true }))
      return [...prev, userId]
    })
  }

  const toggleNotification = async (userId: string) => {
    const newValue = !(memberNotifications[userId] ?? true)
    setMemberNotifications((prev) => ({ ...prev, [userId]: newValue }))

    // Persist immediately if editing an existing card
    if (initial?.id) {
      try {
        await apiFetch(`/api/kanban/cards/${initial.id}/members/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ receiveNotifications: newValue }),
        })
      } catch {
        // Revert on failure
        setMemberNotifications((prev) => ({ ...prev, [userId]: !newValue }))
      }
    }
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      const data: any = {
        title: title.trim(),
        description: description.trim() || null,
        memberIds,
        projectId: projectId || null,
        clientId: clientId || null,
        dueDate: dueDate ? new Date(dueDate + 'T00:00:00Z').toISOString() : null,
      }
      if (!initial) {
        data.columnId = selectedColumnId
      } else if (selectedColumnId !== initial.columnId) {
        data.columnId = selectedColumnId
      }
      await onSave(data)
    } finally {
      setSaving(false)
    }
  }

  // Selected members sorted: admins first, then alpha
  const selectedUsers = useMemo(() => {
    return memberIds
      .map((id) => users.find((u) => u.id === id))
      .filter(Boolean) as KanbanUser[]
  }, [memberIds, users])

  return (
    <Dialog open onOpenChange={(open) => !open && guardedClose()}>
      <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit Task' : 'Add Task'}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-6 py-2">
            {/* ---- LEFT COLUMN: Title, Description, Comments ---- */}
            <div className="space-y-4 min-w-0">
              <div>
                <label className="text-sm font-medium">Title</label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Task title"
                  maxLength={500}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                  maxLength={5000}
                  rows={4}
                />
              </div>

              {/* Comments / History tabs — only for existing cards */}
              {initial?.id && (
                <TaskActivityTabs
                  cardId={initial.id}
                  currentUserId={currentUser?.id || null}
                  isAdmin={currentUser?.isSystemAdmin === true}
                />
              )}
            </div>

            {/* ---- RIGHT COLUMN: Status, Due Date, Project, Users ---- */}
            <div className="space-y-4">
              {/* Status Pill */}
              <div>
                <label className="text-sm font-medium">Status</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="mt-1 flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border hover:bg-muted transition-colors w-full justify-between"
                      style={currentColumn?.color ? {
                        backgroundColor: `${currentColumn.color}20`,
                        borderColor: currentColumn.color,
                        color: currentColumn.color,
                      } : undefined}
                    >
                      <span className="truncate">{currentColumn?.name || 'Select status'}</span>
                      <MoreHorizontal className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[200px]">
                    {columnOptions.map((col) => (
                      <DropdownMenuItem
                        key={col.id}
                        onClick={() => setSelectedColumnId(col.id)}
                      >
                        <span
                          className="w-3 h-3 rounded-full mr-2 flex-shrink-0"
                          style={{ backgroundColor: col.color || 'hsl(var(--muted-foreground))' }}
                        />
                        {col.name}
                        {col.id === selectedColumnId && (
                          <span className="ml-auto text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Due Date */}
              <div>
                <label className="text-sm font-medium">Due Date</label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="flex-1"
                  />
                  {dueDate && (
                    <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setDueDate('')}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Project */}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Client (Optional)</label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title={editingClient ? 'Stop editing' : 'Edit client'}
                    onClick={() => setEditingClient((v) => !v)}
                  >
                    {editingClient ? <X className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                  </Button>
                </div>
                <div className="mt-1">
                  {editingClient ? (
                    <TypeaheadSelect
                      value={clientId}
                      onValueChange={(v) => {
                        setClientId(v)
                        setProjectId('')
                        setEditingClient(false)
                        if (v) setEditingProject(true)
                      }}
                      options={clientOptions}
                      placeholder={loadingClients ? 'Loading…' : 'Search clients...'}
                      allowNone
                      noneLabel="(none)"
                    />
                  ) : clientId ? (
                    <button
                      type="button"
                      onClick={() => { onClose(); router.push(`/admin/clients/${encodeURIComponent(clientId)}`) }}
                      className="h-9 rounded-md border border-border bg-muted px-3 flex items-center hover:underline text-left w-full"
                      title="Open client"
                    >
                      <span className="text-sm truncate">{clientOptions.find((c) => c.value === clientId)?.label ?? clientId}</span>
                    </button>
                  ) : (
                    <div
                      className="h-9 rounded-md border border-border bg-muted px-3 flex items-center text-sm text-muted-foreground cursor-pointer hover:bg-accent"
                      onClick={() => setEditingClient(true)}
                    >
                      None
                    </div>
                  )}
                </div>
              </div>

              {/* Project */}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Project (Optional)</label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title={editingProject ? 'Stop editing' : 'Edit project'}
                    onClick={() => setEditingProject((v) => !v)}
                    disabled={!clientId}
                  >
                    {editingProject ? <X className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                  </Button>
                </div>
                <div className="mt-1">
                  {editingProject ? (
                    <TypeaheadSelect
                      value={projectId}
                      onValueChange={(v) => { setProjectId(v); if (v) setEditingProject(false) }}
                      options={filteredProjectOptions}
                      placeholder={!clientId ? 'Select a client first' : loadingProjects ? 'Loading…' : 'Search projects...'}
                      disabled={!clientId}
                      allowNone
                      noneLabel="(none)"
                    />
                  ) : projectId ? (
                    <button
                      type="button"
                      onClick={() => { onClose(); router.push(`/admin/projects/${encodeURIComponent(projectId)}`) }}
                      className="h-9 rounded-md border border-border bg-muted px-3 flex items-center hover:underline text-left w-full"
                      title="Open project"
                    >
                      <span className="text-sm truncate">{filteredProjectOptions.find((p) => p.value === projectId)?.label ?? projects.find((p) => p.id === projectId)?.title ?? projectId}</span>
                    </button>
                  ) : (
                    <div
                      className="h-9 rounded-md border border-border bg-muted px-3 flex items-center text-sm text-muted-foreground cursor-pointer hover:bg-accent"
                      onClick={() => clientId ? setEditingProject(true) : undefined}
                    >
                      {!clientId ? 'Select a client first' : 'None'}
                    </div>
                  )}
                </div>
              </div>

              {/* Users */}
              <div>
                <label className="text-sm font-medium">Users</label>
                {/* Selected users with notification bells */}
                {selectedUsers.length > 0 && (
                  <div className="mt-1 space-y-1 mb-2">
                    {selectedUsers.map((u) => (
                      <div key={u.id} className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50">
                        <InitialsAvatar
                          name={u.name}
                          email={u.email}
                          displayColor={u.displayColor}
                          avatarUrl={u.avatarPath ? `/api/users/${u.id}/avatar` : null}
                          className="h-6 w-6 text-[9px]"
                        />
                        <span className="text-sm truncate flex-1">{u.name || u.email}</span>
                        <button
                          type="button"
                          className="p-0.5 rounded hover:bg-muted transition-colors"
                          title={memberNotifications[u.id] !== false ? 'Receiving notifications' : 'Notifications muted'}
                          onClick={() => toggleNotification(u.id)}
                        >
                          {memberNotifications[u.id] !== false ? (
                            <Bell className="w-3.5 h-3.5 text-primary" />
                          ) : (
                            <BellOff className="w-3.5 h-3.5 text-muted-foreground" />
                          )}
                        </button>
                        {/* Non-admins can only remove users on Add Task, not Edit Task */}
                        {(isAdmin || !initial) && (
                          <button
                            type="button"
                            className="p-0.5 rounded hover:bg-destructive/10 transition-colors"
                            title="Remove"
                            onClick={() => toggleMember(u.id)}
                          >
                            <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* User list to add from */}
                {users.filter((u) => !memberIds.includes(u.id)).length > 0 && (
                  <div className="border rounded-md max-h-36 overflow-auto p-1.5 space-y-0.5">
                    {users
                      .filter((u) => !memberIds.includes(u.id))
                      .map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted cursor-pointer text-sm w-full text-left"
                          onClick={() => toggleMember(u.id)}
                        >
                          <InitialsAvatar
                            name={u.name}
                            email={u.email}
                            displayColor={u.displayColor}
                            avatarUrl={u.avatarPath ? `/api/users/${u.id}/avatar` : null}
                            className="h-5 w-5 text-[8px]"
                          />
                          <span className="truncate">{u.name || u.email}</span>
                          <Plus className="w-3 h-3 text-muted-foreground ml-auto flex-shrink-0" />
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button className="w-full sm:w-auto" variant="outline" onClick={guardedClose}>
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" variant="default" onClick={handleSave} disabled={!title.trim() || saving}>
            {saving ? 'Saving...' : initial ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Task Activity (Comments + History tabs) ----------

type HistoryEntry = {
  id: string
  action: string
  payload: Record<string, any> | null
  actorNameSnapshot: string | null
  createdAt: string
  actor: {
    id: string
    name: string | null
    displayColor: string | null
    avatarPath: string | null
  } | null
}

function describeHistoryAction(entry: HistoryEntry): string {
  const p = entry.payload ?? {}
  switch (entry.action) {
    case 'CREATED':
      return `created this task`
    case 'MOVED':
      return `moved task from "${p.fromColumnName ?? '?'}" to "${p.toColumnName ?? '?'}"`
    case 'MEMBER_ADDED':
      return `added ${p.targetUserName ?? 'a user'}`
    case 'MEMBER_REMOVED':
      return `removed ${p.targetUserName ?? 'a user'}`
    case 'DUE_DATE_SET': {
      const d = p.date ? new Date(p.date) : null
      return `set due date to ${d ? formatDate(d.toISOString()) : '?'}`
    }
    case 'DUE_DATE_REMOVED':
      return `removed due date`
    case 'PROJECT_LINKED':
      return `linked project: ${p.projectTitle ?? '?'}`
    case 'PROJECT_REMOVED':
      return `removed project: ${p.projectTitle ?? '?'}`
    case 'TITLE_EDITED':
      return `changed title to "${p.newTitle ?? '?'}"`
    case 'DESCRIPTION_EDITED':
      return p.newDescription
        ? `updated description`
        : `removed description`
    default:
      return entry.action.toLowerCase().replace(/_/g, ' ')
  }
}

function TaskActivityTabs({
  cardId,
  currentUserId,
  isAdmin,
}: {
  cardId: string
  currentUserId: string | null
  isAdmin: boolean
}) {
  const [activeTab, setActiveTab] = useState<'comments' | 'history'>('comments')

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-0 border-b mb-3">
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'comments'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('comments')}
        >
          Comments
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'history'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
      </div>

      {activeTab === 'comments' ? (
        <TaskComments cardId={cardId} currentUserId={currentUserId} isAdmin={isAdmin} />
      ) : (
        <TaskHistory cardId={cardId} />
      )}
    </div>
  )
}

function TaskHistory({ cardId }: { cardId: string }) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/api/kanban/cards/${cardId}/history`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setHistory(data.history ?? [])
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load history')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [cardId])

  if (loading) {
    return <p className="text-sm text-muted-foreground py-2">Loading history…</p>
  }
  if (error) {
    return <p className="text-sm text-destructive py-2">{error}</p>
  }
  if (history.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No history yet.</p>
  }

  return (
    <div className="space-y-2">
      {history.map((entry) => {
        const actor = entry.actor
        const displayName = actor?.name ?? entry.actorNameSnapshot ?? 'Unknown'
        return (
          <div key={entry.id} className="flex items-start gap-2.5">
            <InitialsAvatar
              name={actor?.name ?? entry.actorNameSnapshot}
              email={null}
              displayColor={actor?.displayColor ?? null}
              avatarUrl={actor?.avatarPath ? `/api/users/${actor.id}/avatar` : null}
              className="h-6 w-6 text-[9px] flex-shrink-0 mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <span className="text-sm">
                <span className="font-medium">{displayName}</span>{' '}
                <span className="text-muted-foreground">{describeHistoryAction(entry)}</span>
              </span>
              <div className="text-xs text-muted-foreground mt-0.5">
                {formatDateTime(entry.createdAt)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- Task Comments (embedded in card dialog) ----------

function TaskComments({
  cardId,
  currentUserId,
  isAdmin,
}: {
  cardId: string
  currentUserId: string | null
  isAdmin: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [newComment, setNewComment] = useState('')
  const [replyingTo, setReplyingTo] = useState<TaskComment | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const topLevelComments = useMemo(() => {
    return (comments || []).filter((c) => !c.parentId)
  }, [comments])

  const fetchComments = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiJson<TaskComment[]>(`/api/kanban/cards/${cardId}/comments`, {
        cache: 'no-store',
      })
      setComments(Array.isArray(data) ? data : [])
    } catch (e: any) {
      console.error('[TASK COMMENTS] Failed to load:', e)
      setError(e?.message || 'Failed to load comments')
      setComments([])
    } finally {
      setLoading(false)
    }
  }, [cardId])

  useEffect(() => {
    void fetchComments()
  }, [fetchComments])

  useEffect(() => {
    if (topLevelComments.length === 0) return
    if (!shouldAutoScrollRef.current) return
    setTimeout(() => {
      const el = messagesContainerRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      shouldAutoScrollRef.current = false
    }, 0)
  }, [topLevelComments.length])

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom < 40
  }, [])

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedReplies((prev) => ({ ...prev, [commentId]: !(prev[commentId] ?? true) }))
  }, [])

  const submit = useCallback(async () => {
    const trimmed = newComment.trim()
    if (!trimmed) return

    const parentId = replyingTo?.parentId ? null : replyingTo?.id || null

    setLoading(true)
    setError(null)
    try {
      shouldAutoScrollRef.current = true
      await apiPost(`/api/kanban/cards/${cardId}/comments`, {
        content: trimmed,
        parentId,
      })
      setNewComment('')
      setReplyingTo(null)
      await fetchComments()
    } catch (e: any) {
      console.error('[TASK COMMENTS] Failed to post:', e)
      setError(e?.message || 'Failed to post comment')
    } finally {
      setLoading(false)
    }
  }, [cardId, fetchComments, newComment, replyingTo])

  const deleteOne = useCallback(
    async (comment: TaskComment) => {
      const ok = confirm('Delete this comment?')
      if (!ok) return

      setLoading(true)
      setError(null)
      try {
        await apiDelete(`/api/kanban/cards/${cardId}/comments/${comment.id}`)
        if (replyingTo?.id === comment.id) setReplyingTo(null)
        await fetchComments()
      } catch (e: any) {
        console.error('[TASK COMMENTS] Failed to delete:', e)
        setError(e?.message || 'Failed to delete comment')
      } finally {
        setLoading(false)
      }
    },
    [cardId, fetchComments, replyingTo?.id]
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="border rounded-lg">
      <div className="px-3 py-2 border-b">
        <h3 className="text-sm font-semibold">Comments</h3>
      </div>
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="max-h-[300px] overflow-y-auto p-3 space-y-3"
      >
        {loading && topLevelComments.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">Loading...</p>
        )}
        {!loading && topLevelComments.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">No comments yet</p>
        )}
        {error && (
          <p className="text-xs text-destructive text-center">{error}</p>
        )}
        {topLevelComments.map((comment) => (
          <TaskCommentBubble
            key={comment.id}
            comment={comment}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            replies={comment.replies}
            repliesExpanded={expandedReplies[comment.id] ?? true}
            onToggleReplies={() => toggleReplies(comment.id)}
            onReply={(c) => setReplyingTo(c)}
            onDelete={deleteOne}
          />
        ))}
      </div>
      {/* Compose area */}
      <div className="border-t px-3 py-2">
        {replyingTo && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
            <CornerDownRight className="w-3 h-3" />
            <span>Replying to {replyingTo.authorName}</span>
            <button type="button" onClick={() => setReplyingTo(null)} className="ml-auto">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a comment..."
            rows={2}
            className="flex-1 min-h-[40px] resize-none text-sm"
          />
          <Button
            size="icon"
            className="w-8 h-8 flex-shrink-0"
            disabled={!newComment.trim() || loading}
            onClick={() => void submit()}
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------- Task Comment Bubble ----------

function TaskCommentBubble({
  comment,
  currentUserId,
  isAdmin,
  replies,
  repliesExpanded,
  onToggleReplies,
  onReply,
  onDelete,
}: {
  comment: TaskComment
  currentUserId: string | null
  isAdmin: boolean
  replies?: TaskComment[]
  repliesExpanded?: boolean
  onToggleReplies?: () => void
  onReply: (comment: TaskComment) => void
  onDelete: (comment: TaskComment) => void
}) {
  const isMine = Boolean(currentUserId && comment.userId && comment.userId === currentUserId)
  const canDelete = isAdmin || isMine

  return (
    <div className="w-full">
      <div className="bg-card border border-border rounded-lg p-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <InitialsAvatar
              name={comment.authorName || 'Unknown'}
              displayColor={comment.displayColor}
              avatarUrl={comment.avatarUrl}
              className="h-6 w-6 text-[10px]"
            />
            <div className="text-sm font-semibold text-foreground truncate">
              {comment.authorName || 'Unknown'}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDateTime(comment.createdAt)}
            </div>
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Delete"
                onClick={() => onDelete(comment)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground">
          {comment.content}
        </div>

        <div className="mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-2 h-6 text-xs"
            onClick={() => onReply(comment)}
          >
            Reply
          </Button>
        </div>

        {Array.isArray(replies) && replies.length > 0 && onToggleReplies && (
          <div className="mt-3 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onToggleReplies}
              className="flex items-center justify-between w-full mb-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50 hover:bg-muted/70 hover:text-foreground transition-colors"
            >
              <span>
                {replies.length} {replies.length === 1 ? 'Reply' : 'Replies'}
              </span>
            </button>

            {repliesExpanded && (
              <div className="space-y-3">
                {replies.map((reply) => {
                  const replyIsMine = Boolean(currentUserId && reply.userId && reply.userId === currentUserId)
                  const canDeleteReply = isAdmin || replyIsMine

                  return (
                    <div key={reply.id} className="pl-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <CornerDownRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          <InitialsAvatar
                            name={reply.authorName || 'Unknown'}
                            displayColor={reply.displayColor}
                            avatarUrl={reply.avatarUrl}
                            className="h-5 w-5 text-[9px] ring-2"
                          />
                          <span className="text-xs font-semibold text-foreground truncate">
                            {reply.authorName || 'Unknown'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDateTime(reply.createdAt)}
                          </span>
                          {canDeleteReply && (
                            <button
                              type="button"
                              onClick={() => onDelete(reply)}
                              className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                              title="Delete reply"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground">
                        {reply.content}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Archived View ----------

type ArchivedCard = {
  id: string
  title: string
  description: string | null
  dueDate: string | null
  archivedAt: string
  members: KanbanMember[]
  column: { id: string; name: string; color: string | null; position: number }
  project: KanbanProject | null
  client: KanbanClient | null
  _count: { comments: number }
}

function ArchivedView({
  onUnarchive,
  onDelete,
}: {
  onUnarchive: (id: string) => Promise<void>
  onDelete: (card: KanbanCardData) => void
}) {
  const [cards, setCards] = useState<ArchivedCard[]>([])
  const [loading, setLoading] = useState(true)
  const [unarchiving, setUnarchiving] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/kanban/archived')
      if (res.ok) {
        const data = await res.json()
        setCards(data.cards || [])
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleUnarchive = async (card: ArchivedCard) => {
    setUnarchiving(card.id)
    try {
      await onUnarchive(card.id)
      setCards((prev) => prev.filter((c) => c.id !== card.id))
    } finally {
      setUnarchiving(null)
    }
  }

  const toKanbanCardData = (card: ArchivedCard): KanbanCardData => ({
    id: card.id,
    title: card.title,
    description: card.description,
    position: 0,
    columnId: card.column.id,
    projectId: card.project?.id ?? null,
    clientId: card.client?.id ?? null,
    members: card.members,
    project: card.project,
    client: card.client,
    createdBy: { id: '', name: null, email: '' },
    dueDate: card.dueDate,
    archivedAt: card.archivedAt,
    _count: card._count,
    createdAt: card.archivedAt,
    updatedAt: card.archivedAt,
  })

  const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
  const visibleCards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const MAX_AVATARS = 4

  if (loading) {
    return <p className="text-sm text-muted-foreground py-4">Loading archived tasks...</p>
  }

  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No archived tasks.</p>
  }

  return (
    <div className="space-y-1">
      {/* Header row */}
      <div className="hidden md:grid md:grid-cols-[1fr_1fr_120px_120px_120px_88px] gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
        <span>Title / Status</span>
        <span>Client</span>
        <span className="text-center">Comments</span>
        <span>Due Date</span>
        <span>Users</span>
        <span />
      </div>
      {visibleCards.map((card) => {
        const dueDate = card.dueDate ? new Date(card.dueDate) : null
        return (
          <div
            key={card.id}
            className="md:grid md:grid-cols-[1fr_1fr_120px_120px_120px_88px] gap-2 items-center rounded-md border bg-background p-2.5 hover:bg-muted/30 transition-colors"
          >
            {/* Title + status */}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">{card.title}</span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-white flex-shrink-0"
                  style={{ backgroundColor: card.column.color || 'hsl(var(--muted-foreground))' }}
                >
                  {card.column.name}
                </span>
              </div>
              {card.description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{card.description}</p>
              )}
            </div>

            {/* Client */}
            <div className="hidden md:block min-w-0">
              {card.client ? (
                <span className="text-xs text-muted-foreground truncate block">{card.client.name}</span>
              ) : (
                <span className="text-xs text-muted-foreground/40">—</span>
              )}
            </div>

            {/* Comment count */}
            <div className="hidden md:flex items-center justify-center">
              {card._count.comments > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {card._count.comments}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground/40">—</span>
              )}
            </div>

            {/* Due date */}
            <div className="hidden md:block">
              {dueDate ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground"
                >
                  <CalendarDays className="w-2.5 h-2.5" />
                  {formatDate(card.dueDate!)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground/40">—</span>
              )}
            </div>

            {/* Users */}
            <div className="hidden md:flex items-center -space-x-1">
              {card.members.slice(0, MAX_AVATARS).map((m) => (
                <InitialsAvatar
                  key={m.userId}
                  name={m.user.name}
                  email={m.user.email}
                  displayColor={m.user.displayColor}
                  avatarUrl={m.user.avatarPath ? `/api/users/${m.userId}/avatar` : null}
                  className="h-6 w-6 text-[9px] ring-2 ring-card"
                  title={m.user.name || m.user.email || undefined}
                />
              ))}
              {card.members.length > MAX_AVATARS && (
                <div className="h-6 w-6 rounded-full ring-2 ring-card bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground flex-shrink-0">
                  +{card.members.length - MAX_AVATARS}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-1 mt-2 md:mt-0">
              <Button
                variant="ghost"
                size="icon"
                className="w-7 h-7"
                title="Restore task"
                disabled={unarchiving === card.id}
                onClick={() => void handleUnarchive(card)}
              >
                <ArchiveRestore className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-7 h-7 text-destructive hover:text-destructive"
                title="Delete task"
                onClick={() => onDelete(toKanbanCardData(card))}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )
      })}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 px-2 py-2 border-t mt-1">
          <p className="text-xs text-muted-foreground tabular-nums">Page {page} of {totalPages}</p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(1)}>
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ConfirmDeleteDialog({
  title,
  description,
  onConfirm,
  onClose,
}: {
  title: string
  description: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleConfirm = async () => {
    setDeleting(true)
    try {
      await onConfirm()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
