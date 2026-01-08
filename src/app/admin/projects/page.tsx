'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Download, Eye, FolderKanban, Plus, Video } from 'lucide-react'
import ProjectsList from '@/components/ProjectsList'
import { apiFetch } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

type OverviewStats = {
  totalProjects: number
  totalVideos: number
  totalVisits: number
  totalDownloads: number
}

export default function AdminPage() {
  const { user } = useAuth()
  const [projects, setProjects] = useState<any[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<OverviewStats>({ totalProjects: 0, totalVideos: 0, totalVisits: 0, totalDownloads: 0 })

  const permissions = normalizeRolePermissions(user?.permissions)
  const canCreateProject = canDoAction(permissions, 'changeProjectSettings')

  const metricIconWrapperClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const metricIconClassName = 'w-4 h-4 text-primary'

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiFetch('/api/projects')
        if (!res.ok) throw new Error('Failed to load projects')
        const data = await res.json()
        setProjects(data.projects || data || [])

        try {
          const analyticsRes = await apiFetch('/api/analytics')
          if (analyticsRes.ok) {
            const analyticsData = await analyticsRes.json()
            const analyticsProjects = analyticsData.projects || analyticsData || []

            const totalProjects = Array.isArray(analyticsProjects) ? analyticsProjects.length : 0
            const totalVisits = Array.isArray(analyticsProjects)
              ? analyticsProjects.reduce((sum: number, p: any) => sum + (Number(p?.totalVisits) || 0), 0)
              : 0
            const totalDownloads = Array.isArray(analyticsProjects)
              ? analyticsProjects.reduce((sum: number, p: any) => sum + (Number(p?.totalDownloads) || 0), 0)
              : 0
            const totalVideos = Array.isArray(analyticsProjects)
              ? analyticsProjects.reduce((sum: number, p: any) => sum + (Number(p?.videoCount) || 0), 0)
              : 0

            setOverview({ totalProjects, totalVideos, totalVisits, totalDownloads })
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
              <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage your video projects</p>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage your video projects</p>
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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

        <ProjectsList projects={projects} />
      </div>
    </div>
  )
}
