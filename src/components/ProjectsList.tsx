'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { Plus, ArrowUp, ArrowDown, ChevronRight, Filter, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiPatch } from '@/lib/api-client'
import ProjectStatusPicker from '@/components/ProjectStatusPicker'
import { PROJECT_STATUS_OPTIONS, projectStatusDotClass, projectStatusLabel, type ProjectStatus } from '@/lib/project-status'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { getUserInitials } from '@/lib/user-initials'

type ProjectAssignedUser = {
  id: string
  email?: string | null
  name?: string | null
  displayColor?: string | null
  receiveNotifications?: boolean
}

interface Project {
  id: string
  title: string
  companyName: string | null
  clientId: string | null
  status: string
  createdAt: string | Date
  updatedAt: string | Date
  totalBytes?: number | null
  maxRevisions: number
  enableRevisions: boolean
  videos: any[]
  recipients: any[]
  assignedUsers?: ProjectAssignedUser[]
  _count: { comments: number }
  photoCount?: number
}

type ToggleableColumnKey = 'users' | 'videos' | 'versions' | 'comments' | 'photos' | 'data' | 'createdAt' | 'updatedAt'

function formatProjectData(bytes: number | null | undefined): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : null
  if (n === null) return '—'
  const gb = n / (1024 * 1024 * 1024)

  if (gb >= 1000) return '999+ GB'
  if (gb >= 100) return `${Math.round(gb)} GB`
  if (gb >= 10) {
    const v = Number(gb.toFixed(1))
    if (v >= 100) return `${Math.round(v)} GB`
    return `${v.toFixed(1)} GB`
  }
  const v = Number(gb.toFixed(2))
  if (v >= 10) return `${Number(v.toFixed(1)).toFixed(1)} GB`
  return `${v.toFixed(2)} GB`
}

interface ProjectsListProps {
  projects: Project[]
  onFilteredProjectsChange?: (projects: Project[]) => void
}

export default function ProjectsList({ projects, onFilteredProjectsChange }: ProjectsListProps) {
  const router = useRouter()
  const { user } = useAuth()

  const TABLE_SORT_STORAGE_KEY = 'admin_projects_table_sort'
  const TABLE_COLUMNS_STORAGE_KEY = 'admin_projects_table_columns'
  const [isMobile, setIsMobile] = useState(false)
  const [expandedProjectRows, setExpandedProjectRows] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({})
  const [statusToggleLoading, setStatusToggleLoading] = useState<Record<string, boolean>>({})
  const [statusFilterSelected, setStatusFilterSelected] = useState<Set<ProjectStatus>>(new Set())
  const [tableSortKey, setTableSortKey] = useState<
    'title' | 'client' | 'status' | 'users' | 'videos' | 'versions' | 'comments' | 'photos' | 'data' | 'createdAt' | 'updatedAt'
  >('updatedAt')
  const [tableSortDirection, setTableSortDirection] = useState<'asc' | 'desc'>('desc')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)
  const [visibleColumns, setVisibleColumns] = useState<Set<ToggleableColumnKey>>(
    new Set(['users', 'videos', 'versions', 'comments', 'photos', 'data', 'createdAt', 'updatedAt'])
  )

  useEffect(() => {
    const stored = localStorage.getItem(TABLE_SORT_STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      const key = typeof parsed?.key === 'string' ? parsed.key : null
      const direction = parsed?.direction === 'asc' || parsed?.direction === 'desc' ? parsed.direction : null

      const validKeys = new Set([
        'title',
        'client',
        'status',
        'users',
        'videos',
        'versions',
        'comments',
        'photos',
        'data',
        'createdAt',
        'updatedAt',
      ])

      if (key && validKeys.has(key)) setTableSortKey(key as any)
      if (direction) setTableSortDirection(direction)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      TABLE_SORT_STORAGE_KEY,
      JSON.stringify({ key: tableSortKey, direction: tableSortDirection })
    )
  }, [tableSortKey, tableSortDirection])

  useEffect(() => {
    const stored = localStorage.getItem(TABLE_COLUMNS_STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      let storedColumns: unknown = parsed
      let storedVersion: number | undefined

      if (Array.isArray(parsed)) {
        // Back-compat: older versions stored a plain string[] without a version.
        storedColumns = parsed
        storedVersion = 1
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).cols)) {
        storedColumns = (parsed as any).cols
        storedVersion = typeof (parsed as any).v === 'number' ? (parsed as any).v : undefined
      } else {
        return
      }

      if (!Array.isArray(storedColumns)) return
      const allowed = new Set<ToggleableColumnKey>([
        'users',
        'videos',
        'versions',
        'comments',
        'photos',
        'data',
        'createdAt',
        'updatedAt',
      ])
      const next = new Set<ToggleableColumnKey>()
      for (const v of storedColumns) {
        if (typeof v !== 'string') continue
        if (!allowed.has(v as ToggleableColumnKey)) continue
        next.add(v as ToggleableColumnKey)
      }

      // In v1, Users was always shown and couldn't be toggled.
      if (storedVersion === 1) next.add('users')

      if (next.size > 0) setVisibleColumns(next)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(TABLE_COLUMNS_STORAGE_KEY, JSON.stringify({ v: 2, cols: Array.from(visibleColumns) }))
  }, [visibleColumns])

  const permissions = useMemo(() => normalizeRolePermissions(user?.permissions), [user?.permissions])
  const canChangeProjectStatuses = canDoAction(permissions, 'changeProjectStatuses')
  const visibleStatuses = useMemo(() => {
    const allowed = permissions.projectVisibility.statuses
    if (!Array.isArray(allowed) || allowed.length === 0) return undefined
    const allowedSet = new Set(allowed.map((s) => String(s)))
    return PROJECT_STATUS_OPTIONS
      .map((s) => s.value)
      .filter((v) => allowedSet.has(v)) as ProjectStatus[]
  }, [permissions.projectVisibility.statuses])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const formatProjectDate = (date: string | Date) => {
    try {
      const d = new Date(date)
      const yyyy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    } catch {
      return ''
    }
  }

  useEffect(() => {
    const stored = localStorage.getItem('admin_projects_status_filter')
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return
      const valid = new Set(PROJECT_STATUS_OPTIONS.map((s) => s.value))
      const next = new Set<ProjectStatus>()
      parsed.forEach((v) => {
        if (typeof v === 'string' && valid.has(v as ProjectStatus)) next.add(v as ProjectStatus)
      })
      if (next.size > 0) setStatusFilterSelected(next)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_projects_status_filter', JSON.stringify([...statusFilterSelected]))
  }, [statusFilterSelected])


  useEffect(() => {
    // Reset paging when the table settings change.
    setTablePage(1)
  }, [recordsPerPage, searchQuery, tableSortDirection, tableSortKey, statusFilterSelected])

  const getStatusRank = (status: string) => {
    switch (status) {
      case 'NOT_STARTED': return 0
      case 'IN_PROGRESS': return 1
      case 'IN_REVIEW': return 2
      case 'REVIEWED': return 3
      case 'SHARE_ONLY': return 4
      case 'ON_HOLD': return 5
      case 'APPROVED': return 6
      case 'CLOSED': return 7
      default: return 999
    }
  }

  const filteredProjects = useMemo(() => {
    const byStatus = statusFilterSelected.size === 0
      ? projects
      : projects.filter((p) => {
          const effectiveStatus = (statusOverrides[p.id] ?? p.status) as ProjectStatus
          return statusFilterSelected.has(effectiveStatus)
        })

    const q = searchQuery.trim().toLowerCase()
    if (!q) return byStatus

    const getClientName = (project: Project) => {
      const primaryRecipient = project.recipients?.find((r) => r.isPrimary) || project.recipients?.[0]
      return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
    }

    return byStatus.filter((p) => {
      const title = String(p.title || '').toLowerCase()
      const client = String(getClientName(p) || '').toLowerCase()
      const primaryRecipient = p.recipients?.find((r) => r.isPrimary) || p.recipients?.[0]
      const email = String(primaryRecipient?.email || '').toLowerCase()
      return title.includes(q) || client.includes(q) || email.includes(q)
    })
  }, [projects, searchQuery, statusFilterSelected, statusOverrides])

  useEffect(() => {
    onFilteredProjectsChange?.(filteredProjects)
  }, [filteredProjects, onFilteredProjectsChange])

  const tableProjects = useMemo(() => {
    const getClientName = (project: Project) => {
      const primaryRecipient = project.recipients?.find((r) => r.isPrimary) || project.recipients?.[0]
      return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
    }

    const getUniqueVideosCount = (project: Project) => {
      const set = new Set<string>()
      for (const v of project.videos || []) {
        const name = String((v as any)?.name || '')
        if (name) set.add(`name:${name}`)
        else set.add(`id:${String((v as any)?.id || '')}`)
      }
      return set.size
    }

    const getVersionsCount = (project: Project) => (project.videos || []).length

    const getPhotosCount = (project: Project) => Number(project.photoCount) || 0

    const getAssignedUsersCount = (project: Project) =>
      Array.isArray(project.assignedUsers) ? project.assignedUsers.length : 0

    const sorted = [...filteredProjects].sort((a, b) => {
      const dir = tableSortDirection === 'asc' ? 1 : -1

      const aStatus = String(statusOverrides[a.id] ?? a.status)
      const bStatus = String(statusOverrides[b.id] ?? b.status)

      if (tableSortKey === 'title') return dir * a.title.localeCompare(b.title)
      if (tableSortKey === 'client') return dir * getClientName(a).localeCompare(getClientName(b))
      if (tableSortKey === 'status') {
        const delta = getStatusRank(aStatus) - getStatusRank(bStatus)
        if (delta !== 0) return dir * delta
        return dir * a.title.localeCompare(b.title)
      }
      if (tableSortKey === 'users') return dir * (getAssignedUsersCount(a) - getAssignedUsersCount(b))
      if (tableSortKey === 'videos') return dir * (getUniqueVideosCount(a) - getUniqueVideosCount(b))
      if (tableSortKey === 'versions') return dir * (getVersionsCount(a) - getVersionsCount(b))
      if (tableSortKey === 'comments') return dir * ((a._count?.comments || 0) - (b._count?.comments || 0))
      if (tableSortKey === 'photos') return dir * (getPhotosCount(a) - getPhotosCount(b))
      if (tableSortKey === 'data') return dir * ((Number(a.totalBytes) || 0) - (Number(b.totalBytes) || 0))
      if (tableSortKey === 'createdAt') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      if (tableSortKey === 'updatedAt') return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      return 0
    })

    return sorted
  }, [filteredProjects, statusOverrides, tableSortDirection, tableSortKey])

  const tableTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(tableProjects.length / recordsPerPage))
  }, [recordsPerPage, tableProjects.length])

  useEffect(() => {
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages])

  const visibleTableProjects = useMemo(() => {
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return tableProjects.slice(start, end)
  }, [recordsPerPage, tablePage, tableProjects])

  const toggleTableSort = (key: typeof tableSortKey) => {
    setTablePage(1)
    setTableSortKey((prev) => {
      if (prev !== key) {
        setTableSortDirection('asc')
        return key
      }
      setTableSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
      return prev
    })
  }

  const columnsConfig = useMemo(() => {
    const visible = visibleColumns
    const cols = [
      { key: 'title', label: 'Project Name', className: 'min-w-[220px]', mobile: true },
      { key: 'client', label: 'Client', className: 'min-w-[180px] hidden md:table-cell', mobile: false },
      { key: 'status', label: 'Status', className: 'min-w-[120px]', mobile: true },
      { key: 'users', label: 'Users', className: 'w-[105px] hidden md:table-cell px-2 pr-1', mobile: false, toggleKey: 'users' as const },
      { key: 'videos', label: 'Videos', className: 'w-[90px] text-right hidden md:table-cell', mobile: false, toggleKey: 'videos' as const },
      { key: 'versions', label: 'Versions', className: 'w-[95px] text-right hidden md:table-cell', mobile: false, toggleKey: 'versions' as const },
      { key: 'comments', label: 'Comments', className: 'w-[110px] text-right hidden md:table-cell', mobile: false, toggleKey: 'comments' as const },
      { key: 'photos', label: 'Photos', className: 'w-[95px] text-right hidden md:table-cell', mobile: false, toggleKey: 'photos' as const },
      { key: 'data', label: 'Data', className: 'w-[110px] text-right hidden md:table-cell', mobile: false, toggleKey: 'data' as const },
      { key: 'createdAt', label: 'Date Created', className: 'w-[130px] hidden md:table-cell', mobile: false, toggleKey: 'createdAt' as const },
      { key: 'updatedAt', label: 'Last Activity', className: 'w-[130px] hidden md:table-cell', mobile: false, toggleKey: 'updatedAt' as const },
    ] as const

    const visibleCols = cols.filter((c: any) => !c.toggleKey || visible.has(c.toggleKey))
    return {
      visibleCols,
      desktopColSpan: visibleCols.length,
    }
  }, [visibleColumns])

  return (
    <>
      {projects.length > 0 && (
        <div className="flex flex-nowrap items-center justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0 sm:max-w-sm">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="h-9"
              aria-label="Search projects"
            />
          </div>

          <div className="flex flex-nowrap items-center justify-end gap-2 flex-shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hidden md:inline-flex text-muted-foreground hover:text-foreground"
                  aria-label="Show columns"
                  title="Show columns"
                >
                  <Table2 className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                {(
                  [
                    { key: 'users', label: 'Users' },
                    { key: 'videos', label: 'Videos' },
                    { key: 'versions', label: 'Versions' },
                    { key: 'comments', label: 'Comments' },
                    { key: 'photos', label: 'Photos' },
                    { key: 'data', label: 'Data' },
                    { key: 'createdAt', label: 'Date Created' },
                    { key: 'updatedAt', label: 'Last Activity' },
                  ] as const
                ).map((col) => {
                  const checked = visibleColumns.has(col.key)
                  return (
                    <DropdownMenuCheckboxItem
                      key={col.key}
                      checked={checked}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => {
                        setVisibleColumns((prev) => {
                          const next = new Set(prev)
                          if (next.has(col.key)) next.delete(col.key)
                          else next.add(col.key)
                          return next
                        })
                      }}
                    >
                      {col.label}
                    </DropdownMenuCheckboxItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant={statusFilterSelected.size > 0 ? 'default' : 'ghost'}
                  size="sm"
                  className={cn(
                    'inline-flex items-center',
                    statusFilterSelected.size > 0
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-label="Filter statuses"
                  title="Filter statuses"
                >
                  <Filter className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Filter statuses</DropdownMenuLabel>
                {PROJECT_STATUS_OPTIONS.map((s) => {
                  const checked = statusFilterSelected.has(s.value)
                  return (
                    <DropdownMenuCheckboxItem
                      key={s.value}
                      checked={checked}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => {
                        setStatusFilterSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.value)) next.delete(s.value)
                          else next.add(s.value)
                          return next
                        })
                      }}
                    >
                      {s.label}
                    </DropdownMenuCheckboxItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="inline-flex items-center">
              <Select
                value={String(recordsPerPage)}
                onValueChange={(v) => {
                  const parsed = Number(v)
                  if (parsed === 20 || parsed === 50 || parsed === 100) {
                    setRecordsPerPage(parsed)
                  }
                }}
              >
                <SelectTrigger className="h-9 w-[88px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      <div>
        {projects.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground mb-4">No projects yet</p>
              <Link href="/admin/projects/new">
                <Button variant="default" size="default">
                  <Plus className="w-4 h-4 mr-2" />
                  Create Your First Project
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border border-border bg-card overflow-hidden">
            <div className="w-full overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-8 md:hidden" aria-label="Expand" />
                    {columnsConfig.visibleCols.map((col: any) => (
                      <th key={col.key} scope="col" className={cn('px-3 py-2 text-left text-xs font-medium text-muted-foreground', col.className)}>
                        <button
                          type="button"
                          onClick={() => toggleTableSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          title="Sort"
                        >
                          <span>{col.label}</span>
                          {tableSortKey === col.key && (
                            tableSortDirection === 'asc'
                              ? <ArrowUp className="h-3.5 w-3.5" />
                              : <ArrowDown className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleTableProjects.length === 0 ? (
                    <>
                      <tr className="md:hidden">
                        <td colSpan={3} className="px-3 py-10 text-center text-muted-foreground">
                          No projects found.
                        </td>
                      </tr>
                      <tr className="hidden md:table-row">
                        <td colSpan={columnsConfig.desktopColSpan} className="px-3 py-10 text-center text-muted-foreground">
                          No projects found.
                        </td>
                      </tr>
                    </>
                  ) : (
                    visibleTableProjects.map((project) => {
                      const effectiveStatus = statusOverrides[project.id] ?? project.status
                      const isUpdatingStatus = Boolean(statusToggleLoading[project.id])

                      const readyVideos = (project.videos || []).filter((v: any) => v?.status === 'READY')
                      const videosByNameForApproval = readyVideos.reduce((acc: Record<string, any[]>, video: any) => {
                        const name = String(video?.name || '')
                        if (!name) return acc
                        if (!acc[name]) acc[name] = []
                        acc[name].push(video)
                        return acc
                      }, {})
                      const allVideosHaveApprovedVersion = Object.values(videosByNameForApproval).every((versions: any[]) =>
                        versions.some((v: any) => Boolean(v?.approved))
                      )
                      const canApproveProject = readyVideos.length > 0 && allVideosHaveApprovedVersion

                      const uniqueVideos = (() => {
                        const set = new Set<string>()
                        for (const v of project.videos || []) {
                          const name = String(v?.name || '')
                          if (name) set.add(`name:${name}`)
                          else set.add(`id:${String(v?.id || '')}`)
                        }
                        return set.size
                      })()

                      const versionsCount = (project.videos || []).length
                      const commentsCount = project._count?.comments || 0
                      const photosCount = Number(project.photoCount) || 0
                      const dataLabel = formatProjectData(project.totalBytes)
                      const clientName = (() => {
                        const primaryRecipient = project.recipients?.find((r) => r.isPrimary) || project.recipients?.[0]
                        return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
                      })()

                      const isExpanded = Boolean(expandedProjectRows[project.id])
                      const toggleExpanded = () => {
                        setExpandedProjectRows((prev) => ({ ...prev, [project.id]: !prev[project.id] }))
                      }

                      const setStatus = async (nextStatus: string) => {
                        setStatusToggleLoading((prev) => ({ ...prev, [project.id]: true }))
                        try {
                          await apiPatch(`/api/projects/${project.id}`, { status: nextStatus })
                          setStatusOverrides((prev) => ({ ...prev, [project.id]: nextStatus }))
                        } catch (error) {
                          alert('Failed to update project status')
                        } finally {
                          setStatusToggleLoading((prev) => ({ ...prev, [project.id]: false }))
                        }
                      }

                      return (
                        <>
                          <tr
                            key={project.id}
                            className={cn(
                              'border-b border-border last:border-b-0 hover:bg-muted/40',
                              !isMobile && 'cursor-pointer'
                            )}
                            onClick={
                              isMobile
                                ? undefined
                                : () => router.push(`/admin/projects/${project.id}`)
                            }
                            role={isMobile ? undefined : 'link'}
                            tabIndex={isMobile ? undefined : 0}
                            onKeyDown={
                              isMobile
                                ? undefined
                                : (e) => {
                                    if (e.key !== 'Enter') return
                                    router.push(`/admin/projects/${project.id}`)
                                  }
                            }
                          >
                            <td className="px-2 py-2 md:hidden">
                              <button
                                type="button"
                                aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-sm hover:bg-muted/60"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleExpanded()
                                }}
                              >
                                <ChevronRight className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')} />
                              </button>
                            </td>

                            <td className="px-3 py-2 font-medium">
                              <button
                                type="button"
                                className="text-left hover:underline"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  router.push(`/admin/projects/${project.id}`)
                                }}
                              >
                                {project.title}
                              </button>
                            </td>

                            <td className="px-3 py-2 text-muted-foreground hidden md:table-cell">
                              {project.clientId ? (
                                <button
                                  type="button"
                                  className="text-left hover:underline hover:text-foreground transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    router.push(`/admin/clients/${project.clientId}`)
                                  }}
                                >
                                  {clientName}
                                </button>
                              ) : (
                                <span>{clientName}</span>
                              )}
                            </td>

                            <td className="px-3 py-2">
                              <ProjectStatusPicker
                                value={effectiveStatus}
                                disabled={isUpdatingStatus || !canChangeProjectStatuses}
                                canApprove={canApproveProject}
                                stopPropagation
                                className={isUpdatingStatus ? 'opacity-70' : undefined}
                                visibleStatuses={visibleStatuses}
                                onChange={(next) => setStatus(next)}
                              />
                            </td>

                            {visibleColumns.has('users') && (
                              <td className="px-2 pr-1 py-2 hidden md:table-cell">
                                {Array.isArray(project.assignedUsers) && project.assignedUsers.length > 0 ? (
                                  <div className="flex items-center -space-x-1">
                                    {project.assignedUsers.slice(0, 6).map((u, idx) => {
                                      const initials = getUserInitials(u?.name, u?.email)
                                      const bg = typeof u?.displayColor === 'string' && u.displayColor.trim() ? u.displayColor : '#64748b'
                                      const label = String(u?.name || u?.email || '').trim()
                                      return (
                                        <div
                                          key={String(u?.id || idx)}
                                          className="h-7 w-7 rounded-full ring-2 ring-background flex items-center justify-center text-[11px] font-semibold uppercase select-none"
                                          style={{ backgroundColor: bg, color: '#fff' }}
                                          title={label}
                                          aria-label={label}
                                        >
                                          {initials}
                                        </div>
                                      )
                                    })}

                                    {project.assignedUsers.length > 6 && (
                                      <div
                                        className="h-7 w-7 rounded-full ring-2 ring-background flex items-center justify-center text-[11px] font-semibold uppercase select-none"
                                        style={{ backgroundColor: '#94a3b8', color: '#fff' }}
                                        title={`${project.assignedUsers.length - 6} more`}
                                        aria-label={`${project.assignedUsers.length - 6} more`}
                                      >
                                        +{project.assignedUsers.length - 6}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                            )}

                            {visibleColumns.has('videos') && (
                              <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{uniqueVideos}</td>
                            )}
                            {visibleColumns.has('versions') && (
                              <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{versionsCount}</td>
                            )}
                            {visibleColumns.has('comments') && (
                              <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{commentsCount}</td>
                            )}
                            {visibleColumns.has('photos') && (
                              <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{photosCount}</td>
                            )}
                            {visibleColumns.has('data') && (
                              <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{dataLabel}</td>
                            )}
                            {visibleColumns.has('createdAt') && (
                              <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.createdAt)}</td>
                            )}
                            {visibleColumns.has('updatedAt') && (
                              <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.updatedAt)}</td>
                            )}
                          </tr>

                          {isMobile && isExpanded && (
                            <tr className="md:hidden border-b border-border last:border-b-0">
                              <td
                                colSpan={3}
                                className="px-3 py-2 bg-muted/40 dark:bg-muted/10"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="space-y-1 text-sm">
                                  <div className="text-muted-foreground">
                                    <span className="text-foreground">Client:</span> {clientName}
                                  </div>
                                  <div className="grid grid-cols-3 gap-2 tabular-nums">
                                    <div className="text-left">
                                      <span className="text-muted-foreground">Videos:</span> {uniqueVideos}
                                    </div>
                                    <div className="text-center">
                                      <span className="text-muted-foreground">Comments:</span> {commentsCount}
                                    </div>
                                    <div className="text-right">
                                      <span className="text-muted-foreground">Photos:</span> {photosCount}
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between gap-4 tabular-nums">
                                    <div className="text-left">
                                      <span className="text-muted-foreground">Date Created:</span> {formatProjectDate(project.createdAt)}
                                    </div>
                                    <div className="text-right">
                                      <span className="text-muted-foreground">Last Activity:</span> {formatProjectDate(project.updatedAt)}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {tableTotalPages > 1 && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-card">
                <p className="text-xs text-muted-foreground tabular-nums">
                  Page {tablePage} of {tableTotalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setTablePage((p) => Math.max(1, p - 1))}
                    disabled={tablePage === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))}
                    disabled={tablePage === tableTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
