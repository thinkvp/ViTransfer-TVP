'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { BarChart3, FolderKanban, Video, Eye, Download, RefreshCw, ArrowUp, ArrowDown, ChevronDown, Filter, ChevronsDown, ChevronsUp } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import ViewModeToggle, { type ViewMode } from '@/components/ViewModeToggle'
import { cn } from '@/lib/utils'
import { PROJECT_STATUS_OPTIONS, projectStatusDotClass, projectStatusLabel, type ProjectStatus } from '@/lib/project-status'

interface ProjectAnalytics {
  id: string
  title: string
  recipientName: string
  recipientEmail: string | null
  status: string
  videoCount: number
  totalVisits: number
  uniqueVisits: number
  accessByMethod: {
    OTP: number
    PASSWORD: number
    GUEST: number
    NONE: number
  }
  totalDownloads: number
  createdAt: string | Date
  updatedAt: string | Date
}

export default function AnalyticsDashboard() {
  const [projects, setProjects] = useState<ProjectAnalytics[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortMode, setSortMode] = useState<'activity' | 'alphabetical' | 'created'>('alphabetical')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
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

  const loadAnalytics = async () => {
    setLoading(true)
    try {
      const response = await apiFetch('/api/analytics')
      if (!response.ok) throw new Error('Failed to load analytics')
      const data = await response.json()
      setProjects(data.projects || [])
    } catch (error) {
      setProjects([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAnalytics()
  }, [])

  useEffect(() => {
    const storageKey = 'admin_analytics_view'
    const stored = localStorage.getItem(storageKey)

    if (stored === 'grid' || stored === 'list') {
      setViewMode(stored)
      return
    }

    setViewMode('grid')
  }, [])

  useEffect(() => {
    const storedMode = localStorage.getItem('admin_analytics_sort_mode')
    if (storedMode === 'alphabetical' || storedMode === 'created' || storedMode === 'activity') {
      setSortMode(storedMode)
    }
    if (storedMode === 'status') {
      // Back-compat: old value
      setSortMode('activity')
    }

    const storedDirection = localStorage.getItem('admin_analytics_sort_direction')
    if (storedDirection === 'asc' || storedDirection === 'desc') {
      setSortDirection(storedDirection)
    }
  }, [])

  useEffect(() => {
    const storageKey = 'admin_analytics_status_filter'
    const stored = localStorage.getItem(storageKey)
    if (!stored) return

    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return

      const valid = parsed.filter((value) =>
        PROJECT_STATUS_OPTIONS.some((s) => s.value === value)
      ) as ProjectStatus[]

      setStatusFilterSelected(new Set(valid))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_analytics_view', viewMode)
  }, [viewMode])

  useEffect(() => {
    localStorage.setItem('admin_analytics_sort_mode', sortMode)
    localStorage.setItem('admin_analytics_sort_direction', sortDirection)
  }, [sortMode, sortDirection])

  useEffect(() => {
    const storageKey = 'admin_analytics_sections_open'
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
  }, [])

  useEffect(() => {
    if (sectionOpenInitialized) return
    if (loading) return

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
  }, [loading, projects, sectionOpenInitialized])

  useEffect(() => {
    if (!sectionOpenInitialized) return
    localStorage.setItem('admin_analytics_sections_open', JSON.stringify(sectionOpen))
  }, [sectionOpen, sectionOpenInitialized])

  useEffect(() => {
    const storageKey = 'admin_analytics_status_filter'
    if (statusFilterSelected.size === 0) {
      localStorage.removeItem(storageKey)
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(Array.from(statusFilterSelected)))
  }, [statusFilterSelected])

  // Calculate aggregate stats
  const totalProjects = projects.length
  const totalVisits = projects.reduce((sum, p) => sum + p.totalVisits, 0)
  const totalDownloads = projects.reduce((sum, p) => sum + p.totalDownloads, 0)
  const totalVideos = projects.reduce((sum, p) => sum + p.videoCount, 0)

  const compareProjects = useMemo(() => {
    const directionMultiplier = sortDirection === 'asc' ? 1 : -1
    return (a: ProjectAnalytics, b: ProjectAnalytics) => {
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
    const buckets: Record<ProjectStatus, ProjectAnalytics[]> = {} as Record<ProjectStatus, ProjectAnalytics[]>
    PROJECT_STATUS_OPTIONS.forEach((s) => {
      buckets[s.value] = []
    })

    for (const project of projects) {
      const status = project.status as ProjectStatus
      if (status in buckets) {
        buckets[status].push(project)
      } else {
        buckets['IN_REVIEW'].push(project)
      }
    }

    PROJECT_STATUS_OPTIONS.forEach((s) => {
      buckets[s.value] = [...buckets[s.value]].sort(compareProjects)
    })

    return buckets
  }, [compareProjects, projects])

  const visibleStatusOptions = useMemo(() => {
    if (statusFilterSelected.size === 0) return PROJECT_STATUS_OPTIONS
    return PROJECT_STATUS_OPTIONS.filter((s) => statusFilterSelected.has(s.value))
  }, [statusFilterSelected])

  const totalListed = projects.length

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

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading analytics...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-4">
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <BarChart3 className="w-8 h-8" />
            Analytics Dashboard
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Track share page accesses, downloads, and engagement metrics
          </p>
        </div>

        {/* Stats Overview */}
        <Card className="mb-4">
          <CardHeader className="p-3 sm:p-4 pb-2">
            <CardTitle className="text-sm font-medium">Overview</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 sm:p-4 sm:pt-0">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <FolderKanban className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Projects</p>
                  <p className="text-base font-semibold tabular-nums truncate">{totalProjects.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Video className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Videos</p>
                  <p className="text-base font-semibold tabular-nums truncate">{totalVideos.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Eye className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Visits</p>
                  <p className="text-base font-semibold tabular-nums truncate">{totalVisits.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Download className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Downloads</p>
                  <p className="text-base font-semibold tabular-nums truncate">{totalDownloads.toLocaleString()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Projects List */}
        {totalListed === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground opacity-50 mb-4" />
              <p className="text-muted-foreground">
                No analytics data yet
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Analytics will appear once clients start viewing projects
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
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
              <Button
                onClick={loadAnalytics}
                variant="ghost"
                size="sm"
                disabled={loading}
                className="text-muted-foreground hover:text-foreground"
                title="Refresh"
              >
                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              </Button>
            </div>

            {visibleStatusOptions.map((section) => {
              const sectionStatus = section.value
              const sectionProjects = groupedProjects[sectionStatus] || []
              const isOpen = sectionOpen[sectionStatus]

              return (
                <div key={sectionStatus} className="mb-3 rounded-md border border-border bg-card">
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
                      {sectionProjects.map((project) => (
                        <Link
                          key={project.id}
                          href={`/admin/analytics/${project.id}`}
                          className="block group"
                        >
                          <Card className="cursor-pointer transition-all duration-200 hover:border-primary/50 hover:shadow-elevation-lg sm:hover:-translate-y-1">
                            <CardHeader className={cn('p-3 sm:p-4', viewMode === 'grid' && 'p-2 sm:p-3')}>
                              <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
                                <div className="flex-1 min-w-0">
                                  <CardTitle
                                    className={cn(
                                      'font-semibold transition-colors group-hover:text-primary',
                                      viewMode === 'grid' ? 'text-sm sm:text-base break-words' : 'text-base sm:text-lg'
                                    )}
                                  >
                                    {project.title}
                                  </CardTitle>
                                  <CardDescription className={cn('mt-1 break-words', viewMode === 'grid' ? 'text-xs sm:text-sm' : 'text-sm')}>
                                    {project.recipientEmail ? (
                                      <>
                                        Client: {project.recipientName}
                                        <span className="hidden sm:inline"> ({project.recipientEmail})</span>
                                        <span className="block sm:hidden text-xs mt-1">{project.recipientEmail}</span>
                                      </>
                                    ) : (
                                      `Client: ${project.recipientName}`
                                    )}
                                  </CardDescription>
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className={cn('p-3 pt-0 sm:p-4 sm:pt-0', viewMode === 'grid' && 'p-2 pt-0 sm:p-3 sm:pt-0')}>
                              <div className={cn('flex flex-wrap gap-3 sm:gap-6 text-muted-foreground', viewMode === 'grid' ? 'text-xs sm:text-sm' : 'text-sm')}>
                                <div className="inline-flex items-center gap-2">
                                  <span className={metricIconWrapperClassName}>
                                    <Video className={metricIconClassName} />
                                  </span>
                                  <span className="font-medium tabular-nums">{project.videoCount}</span>
                                  <span>
                                    video
                                    {project.videoCount !== 1 ? 's' : ''}
                                  </span>
                                </div>

                                <div className="inline-flex items-center gap-2">
                                  <span className={metricIconWrapperClassName}>
                                    <Eye className={metricIconClassName} />
                                  </span>
                                  <span className="font-medium tabular-nums">{project.totalVisits}</span>
                                  <span>visits</span>
                                </div>

                                <div className="inline-flex items-center gap-2">
                                  <span className={metricIconWrapperClassName}>
                                    <Download className={metricIconClassName} />
                                  </span>
                                  <span className="font-medium tabular-nums">{project.totalDownloads}</span>
                                  <span>downloads</span>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        </Link>
                      ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
