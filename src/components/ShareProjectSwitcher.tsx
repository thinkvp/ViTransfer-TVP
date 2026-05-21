'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'

export type ShareProjectOption = {
  id: string
  title: string
  status: string
  clientName?: string | null
}

type ShareProjectSwitcherProps = {
  currentProjectId: string
  currentProjectTitle: string
  currentProjectStatus: string
  currentProjectClientName?: string | null
  projects: ShareProjectOption[]
  loading?: boolean
  error?: string | null
  includeClientName?: boolean
  searchPlaceholder?: string
  triggerClassName?: string
  onSelectProject: (project: ShareProjectOption) => void
}

export function ShareProjectSwitcher({
  currentProjectId,
  currentProjectTitle,
  currentProjectStatus,
  currentProjectClientName = null,
  projects,
  loading = false,
  error = null,
  includeClientName = false,
  searchPlaceholder = 'Search projects...',
  triggerClassName,
  onSelectProject,
}: ShareProjectSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 320,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(() => {
    const unique = new Map<string, ShareProjectOption>()
    unique.set(currentProjectId, {
      id: currentProjectId,
      title: currentProjectTitle,
      status: currentProjectStatus,
      clientName: currentProjectClientName,
    })
    for (const project of projects) {
      if (!unique.has(project.id)) unique.set(project.id, project)
    }
    return Array.from(unique.values())
  }, [currentProjectClientName, currentProjectId, currentProjectStatus, currentProjectTitle, projects])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return options

    return options.filter((project) => {
      const titleMatch = project.title.toLowerCase().includes(query)
      if (titleMatch) return true
      if (includeClientName && project.clientName) {
        return project.clientName.toLowerCase().includes(query)
      }
      return false
    })
  }, [includeClientName, options, search])

  useEffect(() => {
    if (!open) {
      setSearch('')
      return
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return

    const updateMenuPosition = () => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setMenuPosition({
        left: rect.left,
        top: rect.bottom + 6,
        width: Math.max(rect.width, 320),
      })
    }

    updateMenuPosition()

    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedTrigger = containerRef.current?.contains(target)
      const clickedMenu = menuRef.current?.contains(target)

      if (!clickedTrigger && !clickedMenu) {
        setOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'h-7 max-w-[260px] sm:max-w-[360px] rounded-md border border-input bg-background px-2 text-left text-sm',
          'inline-flex items-center gap-2',
          triggerClassName
        )}
        aria-label="Switch project"
      >
        <span className="truncate text-foreground">{currentProjectTitle}</span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[120] rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-elevation-lg overflow-hidden"
          style={{
            left: `${Math.max(8, menuPosition.left)}px`,
            top: `${Math.max(8, menuPosition.top)}px`,
            width: `min(520px, min(85vw, ${Math.max(240, menuPosition.width)}px))`,
          }}
        >
          <div className="flex items-center gap-1.5 px-2 py-2 border-b border-border/50">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {loading ? (
              <div className="px-2 py-2 text-sm text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading projects...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-2 text-sm text-muted-foreground">
                No matching projects.
              </div>
            ) : (
              filtered.map((project) => {
                const isCurrent = project.id === currentProjectId
                return (
                  <button
                    key={project.id}
                    type="button"
                    className={cn(
                      'w-full text-left rounded-md px-2 py-2 text-sm transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      isCurrent && 'bg-accent/50'
                    )}
                    onClick={() => {
                      if (!isCurrent) {
                        onSelectProject(project)
                      }
                      setOpen(false)
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isCurrent ? <Check className="w-3.5 h-3.5 text-primary shrink-0" /> : <span className="w-3.5 h-3.5 shrink-0" />}
                      <span className="truncate font-medium">{project.title}</span>
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0', projectStatusBadgeClass(project.status))}>
                        {projectStatusLabel(project.status)}
                      </span>
                      {includeClientName && project.clientName ? (
                        <span className="truncate text-muted-foreground">{project.clientName}</span>
                      ) : null}
                    </div>
                  </button>
                )
              })
            )}

            {!loading && error ? (
              <div className="px-2 py-2 text-sm text-destructive border-t border-border/50 mt-1">{error}</div>
            ) : null}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
