'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Download, Eye, FolderKanban, Image as ImageIcon, Layers, Plus, Video } from 'lucide-react'
import ProjectsList from '@/components/ProjectsList'
import { apiFetch } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

type Project = {
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
  photoCount?: number
}

type AnalyticsProject = {
  id: string
  totalVisits?: number
  totalDownloads?: number
  videoCount?: number
}

type OverviewStats = {
  totalProjects: number
  totalVideos: number
  totalVersions: number
  totalPhotos: number
  totalVisits: number
  totalDownloads: number
}

export default function AdminPage() {
  const { user } = useAuth()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [filteredProjects, setFilteredProjects] = useState<Project[] | null>(null)
  const [analyticsByProjectId, setAnalyticsByProjectId] = useState<Record<string, AnalyticsProject>>({})

  const permissions = normalizeRolePermissions(user?.permissions)
  const canCreateProject = canDoAction(permissions, 'changeProjectSettings')

  const metricIconWrapperClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const metricIconClassName = 'w-4 h-4 text-primary'

  const overview = useMemo<OverviewStats>(() => {
    const list = filteredProjects ?? projects ?? []

    const getUniqueVideosCount = (project: Project) => {
      const set = new Set<string>()
      for (const v of project.videos || []) {
        const name = String((v as any)?.name || '')
        if (name) set.add(`name:${name}`)
        else set.add(`id:${String((v as any)?.id || '')}`)
      }
      return set.size
    }

    const totals = list.reduce(
      (acc, project) => {
        const analytics = analyticsByProjectId[project.id]

        acc.totalProjects += 1
        acc.totalVideos += getUniqueVideosCount(project)
        acc.totalVersions += (project.videos || []).length
        acc.totalPhotos += Number(project.photoCount) || 0
        acc.totalVisits += Number(analytics?.totalVisits) || 0
        acc.totalDownloads += Number(analytics?.totalDownloads) || 0
        return acc
      },
      { totalProjects: 0, totalVideos: 0, totalVersions: 0, totalPhotos: 0, totalVisits: 0, totalDownloads: 0 }
    )

    return totals
  }, [analyticsByProjectId, filteredProjects, projects])

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiFetch('/api/projects')
        if (!res.ok) throw new Error('Failed to load projects')
        const data = await res.json()
        const loadedProjects = (data.projects || data || []) as Project[]
        setProjects(loadedProjects)

        try {
          const analyticsRes = await apiFetch('/api/analytics')
          if (analyticsRes.ok) {
            const analyticsData = await analyticsRes.json()
            const analyticsProjects = analyticsData.projects || analyticsData || []

            if (Array.isArray(analyticsProjects)) {
              const next: Record<string, AnalyticsProject> = {}
              for (const p of analyticsProjects) {
                const id = String((p as any)?.id || '')
                if (!id) continue
                next[id] = {
                  id,
                  totalVisits: Number((p as any)?.totalVisits) || 0,
                  totalDownloads: Number((p as any)?.totalDownloads) || 0,
                  videoCount: Number((p as any)?.videoCount) || 0,
                }
              }
              setAnalyticsByProjectId(next)
            }
          }
        } catch {
          // Analytics totals are optional; fall back to 0s
        }
      } catch (error) {
        setProjects([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading projects...</p>
      </div>
    )
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="flex-1 min-h-0 bg-background">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
          <div className="flex justify-between items-center gap-4 mb-4 sm:mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
                <FolderKanban className="w-7 h-7 sm:w-8 sm:h-8" />
                Projects Dashboard
              </h1>
              <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage your video and photo projects</p>
            </div>
            {canCreateProject && (
              <Link href="/admin/projects/new">
                <Button variant="default" size="default">
                  <Plus className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">New Project</span>
                </Button>
              </Link>
            )}
          </div>

          <Card className="mb-4">
            <CardContent className="p-3 sm:p-4">
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <FolderKanban className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Projects</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalProjects.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <Video className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Videos</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalVideos.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <Layers className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Versions</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalVersions.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <ImageIcon className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Photos</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalPhotos.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <Eye className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Visits</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalVisits.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className={metricIconWrapperClassName}>
                    <Download className={metricIconClassName} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Downloads</p>
                    <p className="text-base font-semibold tabular-nums truncate">{overview.totalDownloads.toLocaleString()}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="text-muted-foreground">No projects found.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="flex justify-between items-center gap-4 mb-4 sm:mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
              <FolderKanban className="w-7 h-7 sm:w-8 sm:h-8" />
              Projects Dashboard
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage your video and photo projects</p>
          </div>
          {canCreateProject && (
            <Link href="/admin/projects/new">
              <Button variant="default" size="default">
                <Plus className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">New Project</span>
              </Button>
            </Link>
          )}
        </div>

        <Card className="mb-4">
          <CardContent className="p-3 sm:p-4">
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <FolderKanban className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Projects</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalProjects.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Video className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Videos</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalVideos.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Layers className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Versions</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalVersions.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <ImageIcon className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Photos</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalPhotos.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Eye className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Visits</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalVisits.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Download className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Downloads</p>
                  <p className="text-base font-semibold tabular-nums truncate">{overview.totalDownloads.toLocaleString()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <ProjectsList projects={projects} onFilteredProjectsChange={setFilteredProjects} />
      </div>
    </div>
  )
}
