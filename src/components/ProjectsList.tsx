'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { Plus, Video, MessageSquare, ArrowUp, ArrowDown, ChevronDown, ChevronRight, Filter, ChevronsDown, ChevronsUp } from 'lucide-react'
import ViewModeToggle, { type ViewMode } from '@/components/ViewModeToggle'
import { cn } from '@/lib/utils'
import { apiPatch } from '@/lib/api-client'
import ProjectStatusPicker from '@/components/ProjectStatusPicker'
import { PROJECT_STATUS_OPTIONS, projectStatusDotClass, projectStatusLabel, type ProjectStatus } from '@/lib/project-status'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

interface Project {
  id: string
  title: string
  companyName: string | null
  status: string
  createdAt: string | Date
  updatedAt: string | Date
  maxRevisions: number
  enableRevisions: boolean
  videos: any[]
  recipients: any[]
  _count: { comments: number }
}

interface ProjectsListProps {
  projects: Project[]
  onFilteredProjectsChange?: (projects: Project[]) => void
}

export default function ProjectsList({ projects, onFilteredProjectsChange }: ProjectsListProps) {
  const router = useRouter()
  const { user } = useAuth()
  const [isMobile, setIsMobile] = useState(false)
  const [expandedProjectRows, setExpandedProjectRows] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<'activity' | 'alphabetical' | 'created'>('alphabetical')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({})
  const [statusToggleLoading, setStatusToggleLoading] = useState<Record<string, boolean>>({})
  const [statusFilterSelected, setStatusFilterSelected] = useState<Set<ProjectStatus>>(new Set())
  const [tableSortKey, setTableSortKey] = useState<
    'title' | 'client' | 'status' | 'videos' | 'versions' | 'comments' | 'createdAt' | 'updatedAt'
  >('updatedAt')
  const [tableSortDirection, setTableSortDirection] = useState<'asc' | 'desc'>('desc')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)
  const [sectionOpenInitialized, setSectionOpenInitialized] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<ProjectStatus, boolean>>(() => {
    const initial = {} as Record<ProjectStatus, boolean>
    PROJECT_STATUS_OPTIONS.forEach((s) => {
      initial[s.value] = true
    })
    return initial
  })
  const metricIconWrapperClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const metricIconClassName = 'w-4 h-4 text-primary'

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
    const storageKey = 'admin_projects_view'
    const stored = localStorage.getItem(storageKey)

    if (stored === 'grid' || stored === 'list' || stored === 'table') {
      setViewMode(stored)
      return
    }

    setViewMode('grid')
  }, [])

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
    const storedMode = localStorage.getItem('admin_projects_sort_mode')
    if (storedMode === 'alphabetical' || storedMode === 'created' || storedMode === 'activity') {
      setSortMode(storedMode)
    }
    if (storedMode === 'status') {
      // Back-compat: old value
      setSortMode('activity')
    }

    const storedDirection = localStorage.getItem('admin_projects_sort_direction')
    if (storedDirection === 'asc' || storedDirection === 'desc') {
      setSortDirection(storedDirection)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_projects_view', viewMode)
  }, [viewMode])

  useEffect(() => {
    // Reset paging when switching to table view or when the table settings change.
    if (viewMode !== 'table') return
    setTablePage(1)
  }, [recordsPerPage, searchQuery, tableSortDirection, tableSortKey, statusFilterSelected, viewMode])

  useEffect(() => {
    localStorage.setItem('admin_projects_sort_mode', sortMode)
    localStorage.setItem('admin_projects_sort_direction', sortDirection)
  }, [sortMode, sortDirection])

  useEffect(() => {
    const storageKey = 'admin_projects_sections_open'
    const stored = localStorage.getItem(storageKey)

    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (parsed && typeof parsed === 'object') {
          const next = {} as Record<ProjectStatus, boolean>
          PROJECT_STATUS_OPTIONS.forEach((s) => {
            next[s.value] = Boolean((parsed as any)[s.value])
          })
          setSectionOpen(next)
          setSectionOpenInitialized(true)
          return
        }
      } catch {
        // ignore
      }
    }

    const counts: Record<ProjectStatus, number> = {} as Record<ProjectStatus, number>
    PROJECT_STATUS_OPTIONS.forEach((s) => {
      counts[s.value] = 0
    })

    for (const project of projects) {
      const status = (project.status as ProjectStatus)
      if (status in counts) counts[status] += 1
      else counts['IN_REVIEW'] += 1
    }

    const next = {} as Record<ProjectStatus, boolean>
    PROJECT_STATUS_OPTIONS.forEach((s) => {
      next[s.value] = counts[s.value] > 0
    })
    setSectionOpen(next)
    setSectionOpenInitialized(true)
  }, [projects])

  useEffect(() => {
    if (!sectionOpenInitialized) return
    localStorage.setItem('admin_projects_sections_open', JSON.stringify(sectionOpen))
  }, [sectionOpen, sectionOpenInitialized])

  const compareProjects = useMemo(() => {
    const directionMultiplier = sortDirection === 'asc' ? 1 : -1
    return (a: Project, b: Project) => {
      if (sortMode === 'alphabetical') {
        return directionMultiplier * a.title.localeCompare(b.title)
      }
      if (sortMode === 'created') {
        return directionMultiplier * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      }
      // Activity sorting (updatedAt)
      return directionMultiplier * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
    }
  }, [sortDirection, sortMode])

  const groupedProjects = useMemo(() => {
    const buckets: Record<ProjectStatus, Project[]> = {} as Record<ProjectStatus, Project[]>
    PROJECT_STATUS_OPTIONS.forEach((s) => {
      buckets[s.value] = []
    })

    for (const project of projects) {
      const effectiveStatus = (statusOverrides[project.id] ?? project.status) as ProjectStatus
      if (effectiveStatus in buckets) {
        buckets[effectiveStatus].push(project)
      } else {
        buckets['IN_REVIEW'].push(project)
      }
    }

    PROJECT_STATUS_OPTIONS.forEach((s) => {
      buckets[s.value] = [...buckets[s.value]].sort(compareProjects)
    })

    return buckets
  }, [compareProjects, projects, statusOverrides])

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

    const sorted = [...filteredProjects].sort((a, b) => {
      const dir = tableSortDirection === 'asc' ? 1 : -1

      const aStatus = String(statusOverrides[a.id] ?? a.status)
      const bStatus = String(statusOverrides[b.id] ?? b.status)

      const getStatusRank = (status: string) => {
        switch (status) {
          case 'NOT_STARTED': return 0
          case 'IN_REVIEW': return 1
          case 'ON_HOLD': return 2
          case 'SHARE_ONLY': return 3
          case 'APPROVED': return 4
          case 'CLOSED': return 5
          default: return 999
        }
      }

      if (tableSortKey === 'title') return dir * a.title.localeCompare(b.title)
      if (tableSortKey === 'client') return dir * getClientName(a).localeCompare(getClientName(b))
      if (tableSortKey === 'status') {
        const delta = getStatusRank(aStatus) - getStatusRank(bStatus)
        if (delta !== 0) return dir * delta
        return dir * a.title.localeCompare(b.title)
      }
      if (tableSortKey === 'videos') return dir * (getUniqueVideosCount(a) - getUniqueVideosCount(b))
      if (tableSortKey === 'versions') return dir * (getVersionsCount(a) - getVersionsCount(b))
      if (tableSortKey === 'comments') return dir * ((a._count?.comments || 0) - (b._count?.comments || 0))
      if (tableSortKey === 'createdAt') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      if (tableSortKey === 'updatedAt') return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      return 0
    })

    return sorted
  }, [filteredProjects, statusOverrides, tableSortDirection, tableSortKey])

  const tableTotalPages = useMemo(() => {
    if (viewMode !== 'table') return 1
    return Math.max(1, Math.ceil(tableProjects.length / recordsPerPage))
  }, [recordsPerPage, tableProjects.length, viewMode])

  useEffect(() => {
    if (viewMode !== 'table') return
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages, viewMode])

  const visibleTableProjects = useMemo(() => {
    if (viewMode !== 'table') return [] as Project[]
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return tableProjects.slice(start, end)
  }, [recordsPerPage, tablePage, tableProjects, viewMode])

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

  const visibleStatusOptions = useMemo(() => {
    if (statusFilterSelected.size === 0) return PROJECT_STATUS_OPTIONS
    return PROJECT_STATUS_OPTIONS.filter((s) => statusFilterSelected.has(s.value))
  }, [statusFilterSelected])

  const sortModeLabel = sortMode === 'alphabetical' ? 'Alphabetical' : sortMode === 'activity' ? 'Activity' : 'Created'
  const SortDirectionIcon = sortDirection === 'asc' ? ArrowUp : ArrowDown
  const areAllSectionsOpen = useMemo(
    () => PROJECT_STATUS_OPTIONS.every((s) => Boolean(sectionOpen[s.value])),
    [sectionOpen]
  )

  const cycleSort = () => {
    if (sortMode === 'alphabetical' && sortDirection === 'asc') {
      setSortDirection('desc')
      return
    }
    if (sortMode === 'alphabetical' && sortDirection === 'desc') {
      setSortMode('activity')
      setSortDirection('asc')
      return
    }
    if (sortMode === 'activity' && sortDirection === 'asc') {
      setSortDirection('desc')
      return
    }
    if (sortMode === 'activity' && sortDirection === 'desc') {
      setSortMode('created')
      setSortDirection('asc')
      return
    }
    if (sortMode === 'created' && sortDirection === 'asc') {
      setSortDirection('desc')
      return
    }

    setSortMode('alphabetical')
    setSortDirection('asc')
  }

  return (
    <>
      {projects.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="w-full sm:w-auto sm:flex-1 sm:max-w-sm">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="h-9"
              aria-label="Search projects"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
          {viewMode !== 'table' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={cycleSort}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                title="Change sort"
              >
                <span>{sortModeLabel}</span>
                <SortDirectionIcon className="w-4 h-4" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground inline-flex items-center"
                aria-label={areAllSectionsOpen ? 'Collapse all status sections' : 'Expand all status sections'}
                title={areAllSectionsOpen ? 'Collapse all status sections' : 'Expand all status sections'}
                onClick={() => {
                  const next = {} as Record<ProjectStatus, boolean>
                  PROJECT_STATUS_OPTIONS.forEach((s) => {
                    next[s.value] = !areAllSectionsOpen
                  })
                  setSectionOpen(next)
                }}
              >
                {areAllSectionsOpen ? <ChevronsUp className="w-4 h-4" /> : <ChevronsDown className="w-4 h-4" />}
              </Button>
            </>
          )}

          {viewMode === 'table' && (
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
          )}

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

          <ViewModeToggle value={viewMode} onChange={setViewMode} />
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
        ) : viewMode === 'table' ? (
          <div className="rounded-md border border-border bg-card overflow-hidden">
            <div className="w-full overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-8 md:hidden" aria-label="Expand" />
                    {(
                      [
                        { key: 'title', label: 'Project Name', className: 'min-w-[220px]', mobile: true },
                        { key: 'client', label: 'Client', className: 'min-w-[180px] hidden md:table-cell', mobile: false },
                        { key: 'status', label: 'Status', className: 'min-w-[120px]', mobile: true },
                        { key: 'videos', label: 'Videos', className: 'w-[90px] text-right hidden md:table-cell', mobile: false },
                        { key: 'versions', label: 'Versions', className: 'w-[95px] text-right hidden md:table-cell', mobile: false },
                        { key: 'comments', label: 'Comments', className: 'w-[110px] text-right hidden md:table-cell', mobile: false },
                        { key: 'createdAt', label: 'Date Created', className: 'w-[130px] hidden md:table-cell', mobile: false },
                        { key: 'updatedAt', label: 'Last Activity', className: 'w-[130px] hidden md:table-cell', mobile: false },
                      ] as const
                    ).map((col) => (
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
                        <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
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
                              {clientName}
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

                            <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{uniqueVideos}</td>
                            <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{versionsCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{commentsCount}</td>
                            <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.createdAt)}</td>
                            <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.updatedAt)}</td>
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
                                      <span className="text-muted-foreground">Versions:</span> {versionsCount}
                                    </div>
                                    <div className="text-right">
                                      <span className="text-muted-foreground">Comments:</span> {commentsCount}
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
        ) : (
          <div className="space-y-3">
            {visibleStatusOptions.map((section) => {
              const sectionStatus = section.value
              const sectionProjects = groupedProjects[sectionStatus] || []
              const isOpen = sectionOpen[sectionStatus]

              return (
                <div key={sectionStatus} className="rounded-md border border-border bg-card">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-between px-3 py-2 text-foreground rounded-none rounded-t-md hover:bg-muted/40"
                    onClick={() => setSectionOpen(prev => ({ ...prev, [sectionStatus]: !prev[sectionStatus] }))}
                  >
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <ChevronDown className={cn('w-4 h-4 transition-transform', !isOpen && '-rotate-90')} />
                      <span
                        className={cn(
                          'h-3 w-3 rounded-full border border-border flex-shrink-0 bg-current',
                          projectStatusDotClass(sectionStatus)
                        )}
                      />
                      <span className="font-semibold text-base sm:text-lg truncate">{projectStatusLabel(sectionStatus)}</span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">{sectionProjects.length}</span>
                  </Button>

                  {isOpen && (
                    <div className="border-t border-border p-2 bg-foreground/5 dark:bg-foreground/10">
                      <div
                        className={cn(
                          viewMode === 'grid'
                            ? 'grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4'
                            : 'space-y-3'
                        )}
                      >
                      {sectionProjects.map((project) => {
                        const totalVideos = project.videos.length
                        const status = statusOverrides[project.id] ?? project.status
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

                        const setStatus = async (nextStatus: string) => {
                          setStatusToggleLoading(prev => ({ ...prev, [project.id]: true }))
                          try {
                            await apiPatch(`/api/projects/${project.id}`, { status: nextStatus })
                            setStatusOverrides(prev => ({ ...prev, [project.id]: nextStatus }))
                          } catch (error) {
                            alert('Failed to update project status')
                          } finally {
                            setStatusToggleLoading(prev => ({ ...prev, [project.id]: false }))
                          }
                        }

                        return (
                          <Link key={project.id} href={`/admin/projects/${project.id}`} className="block">
                            <Card className="relative cursor-pointer transition-all duration-200 hover:border-primary/50 hover:shadow-elevation-lg sm:hover:-translate-y-1">
                              <CardHeader className={cn('p-3 sm:p-4', viewMode === 'grid' && 'p-2 sm:p-3')}>
                                <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
                                  <div className="flex-1 min-w-0">
                                    <CardTitle className={cn('font-semibold', viewMode === 'grid' ? 'text-sm sm:text-base' : 'text-base sm:text-lg')}>
                                      {project.title}
                                    </CardTitle>
                                    <CardDescription className={cn('mt-1 break-words', viewMode === 'grid' ? 'text-xs sm:text-sm' : 'text-sm')}>
                                      {(() => {
                                        const primaryRecipient = project.recipients?.find(r => r.isPrimary) || project.recipients?.[0]
                                        const displayName = project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'

                                        return (
                                          <>
                                            Client: {displayName}
                                            {!project.companyName && primaryRecipient?.name && primaryRecipient?.email && (
                                              <>
                                                <span className="hidden sm:inline"> ({primaryRecipient.email})</span>
                                                <span className="block sm:hidden text-xs mt-1">{primaryRecipient.email}</span>
                                              </>
                                            )}
                                          </>
                                        )
                                      })()}
                                    </CardDescription>
                                  </div>
                                  <div className="flex flex-row sm:flex-col items-start sm:items-end gap-2 w-full sm:w-auto">
                                    <ProjectStatusPicker
                                      value={status}
                                      disabled={isUpdatingStatus || !canChangeProjectStatuses}
                                      canApprove={canApproveProject}
                                      stopPropagation
                                      className={isUpdatingStatus ? 'opacity-70' : undefined}
                                      visibleStatuses={visibleStatuses}
                                      onChange={(next) => setStatus(next)}
                                    />
                                  </div>
                                </div>
                              </CardHeader>
                              <CardContent
                                className={cn(
                                  'p-3 pt-0 sm:p-4 sm:pt-0',
                                  viewMode === 'grid' && 'p-2 pt-0 sm:p-3 sm:pt-0 pr-20 sm:pr-24'
                                )}
                              >
                                <div className={cn('flex flex-wrap gap-3 sm:gap-6 text-muted-foreground', viewMode === 'grid' ? 'text-xs sm:text-sm' : 'text-sm')}>
                                  <div className="inline-flex items-center gap-2">
                                    <span className={metricIconWrapperClassName}>
                                      <Video className={metricIconClassName} />
                                    </span>
                                    <span className="font-medium">{totalVideos}</span>
                                    <span>
                                      video
                                      {totalVideos !== 1 ? 's' : ''}
                                    </span>
                                  </div>
                                  <div className="inline-flex items-center gap-2">
                                    <span className={metricIconWrapperClassName}>
                                      <MessageSquare className={metricIconClassName} />
                                    </span>
                                    <span className="font-medium">{project._count.comments}</span>
                                    <span>
                                      comment
                                      {project._count.comments !== 1 ? 's' : ''}
                                    </span>
                                  </div>
                                </div>

                                <div
                                  className={cn(
                                    'absolute bottom-2 right-2 text-right text-muted-foreground',
                                    'hidden sm:block',
                                    viewMode === 'grid' ? 'text-[10px] sm:text-xs leading-tight' : 'text-xs'
                                  )}
                                >
                                  {viewMode === 'grid' ? (
                                    <>
                                      <div>Project Created:</div>
                                      <div className="font-medium tabular-nums">{formatProjectDate(project.createdAt)}</div>
                                    </>
                                  ) : (
                                    <div className="tabular-nums">Project Created: <span className="font-medium">{formatProjectDate(project.createdAt)}</span></div>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          </Link>
                        )
                      })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
