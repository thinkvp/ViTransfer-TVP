'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { Plus, Video, MessageSquare, ArrowUp, ArrowDown, ChevronDown, Filter, ChevronsDown, ChevronsUp } from 'lucide-react'
import ViewModeToggle, { type ViewMode } from '@/components/ViewModeToggle'
import { cn } from '@/lib/utils'
import { apiPatch } from '@/lib/api-client'
import ProjectStatusPicker from '@/components/ProjectStatusPicker'
import { PROJECT_STATUS_OPTIONS, projectStatusDotClass, projectStatusLabel, type ProjectStatus } from '@/lib/project-status'

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
}

export default function ProjectsList({ projects }: ProjectsListProps) {
  const [sortMode, setSortMode] = useState<'activity' | 'alphabetical' | 'created'>('alphabetical')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({})
  const [statusToggleLoading, setStatusToggleLoading] = useState<Record<string, boolean>>({})
  const [statusFilterSelected, setStatusFilterSelected] = useState<Set<ProjectStatus>>(new Set())
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

    if (stored === 'grid' || stored === 'list') {
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
        <div className="flex flex-wrap items-center justify-end gap-2 mb-3">
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
                                      disabled={isUpdatingStatus}
                                      canApprove={canApproveProject}
                                      stopPropagation
                                      className={isUpdatingStatus ? 'opacity-70' : undefined}
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
