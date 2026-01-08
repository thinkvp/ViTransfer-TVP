'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import AdminVideoManager from '@/components/AdminVideoManager'
import ProjectActions from '@/components/ProjectActions'
import ShareLink from '@/components/ShareLink'
import CommentSection from '@/components/CommentSection'
import { ArrowLeft, Settings, ArrowUpDown, FolderKanban, Video } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { apiPatch } from '@/lib/api-client'
import ProjectStatusPicker from '@/components/ProjectStatusPicker'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

// Force dynamic rendering (no static pre-rendering)
export const dynamic = 'force-dynamic'

export default function ProjectPage() {
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string

  const [project, setProject] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [shareUrl, setShareUrl] = useState('')
  const [companyName, setCompanyName] = useState('Studio')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  const [sortMode, setSortMode] = useState<'status' | 'alphabetical'>('alphabetical')
  const [adminUser, setAdminUser] = useState<any>(null)
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false)

  const permissions = useMemo(() => normalizeRolePermissions(adminUser?.permissions), [adminUser?.permissions])
  const canAccessProjectSettings = canDoAction(permissions, 'accessProjectSettings')
  const canChangeProjectStatuses = canDoAction(permissions, 'changeProjectStatuses')

  // Derive active videos from selected video name (synchronous, no useEffect delay)
  const activeVideos = useMemo(() => {
    if (!project?.videos || !activeVideoName) return []
    return project.videos.filter((v: any) => v.name === activeVideoName)
  }, [project?.videos, activeVideoName])

  // Fetch project data function (extracted so it can be called on upload complete)
  const fetchProject = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/projects/${id}`)
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/projects')
          return
        }
        throw new Error('Failed to fetch project')
      }
      const data = await response.json()
      setProject(data)
    } catch (error) {
      console.error('Error fetching project:', error)
    } finally {
      setLoading(false)
    }
  }, [id, router])

  // Fetch project data on mount
  useEffect(() => {
    fetchProject()
  }, [fetchProject])

  // Listen for immediate updates (approval changes, comment deletes/posts, etc.)
  useEffect(() => {
    const handleUpdate = () => fetchProject()

    const handleCommentPosted = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail?.comments) {
        setProject((prev: any) => prev ? { ...prev, comments: customEvent.detail.comments } : prev)
      } else {
        fetchProject()
      }
    }

    window.addEventListener('videoApprovalChanged', handleUpdate)
    window.addEventListener('commentDeleted', handleUpdate)
    window.addEventListener('commentPosted', handleCommentPosted as EventListener)

    return () => {
      window.removeEventListener('videoApprovalChanged', handleUpdate)
      window.removeEventListener('commentDeleted', handleUpdate)
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
    }
  }, [fetchProject])

  // Auto-refresh when videos are processing to show real-time progress
  // Centralized polling to prevent duplicate network requests
  useEffect(() => {
    if (!project?.videos) return

    // Check if any videos are currently processing
    const hasProcessingVideos = project.videos.some(
      (video: any) => video.status === 'PROCESSING' || video.status === 'UPLOADING'
    )

    if (hasProcessingVideos) {
      // Poll every 5 seconds while videos are processing (reduced from 3s to reduce load)
      const interval = setInterval(() => {
        fetchProject()
      }, 5000)

      return () => clearInterval(interval)
    }
  }, [project?.videos, fetchProject])

  // Fetch share URL
  useEffect(() => {
    async function fetchShareUrl() {
      if (!project?.slug) return
      try {
        const response = await apiFetch(`/api/share/url?slug=${project.slug}`)
        if (response.ok) {
          const data = await response.json()
          setShareUrl(data.shareUrl)
        }
      } catch (error) {
        console.error('Error fetching share URL:', error)
      }
    }

    fetchShareUrl()
  }, [project?.slug])

  // Fetch company name and admin user
  useEffect(() => {
    async function fetchCompanyName() {
      try {
        const response = await apiFetch('/api/settings')
        if (response.ok) {
          const data = await response.json()
          setCompanyName(data.companyName || 'Studio')
        }
      } catch (error) {
        console.error('Error fetching company name:', error)
      }
    }

    async function fetchAdminUser() {
      try {
        const response = await apiFetch('/api/auth/session')
        if (response.ok) {
          const data = await response.json()
          setAdminUser(data.user)
        }
      } catch (error) {
        console.error('Error fetching admin user:', error)
      }
    }

    fetchCompanyName()
    fetchAdminUser()
  }, [])

  // Handle video selection
  const handleVideoSelect = (videoName: string, videos: any[]) => {
    setActiveVideoName(videoName)
    // activeVideos is now derived from activeVideoName via useMemo
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Project not found</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter comments to only show comments for active videos
  const activeVideoIds = new Set(activeVideos.map((v: any) => v.id))
  const filteredComments = project?.comments?.filter((comment: any) => {
    // Show general comments (no videoId) or comments for active videos
    return !comment.videoId || activeVideoIds.has(comment.videoId)
  }) || []

  const hideFeedback = (project as any).hideFeedback === true
  const hideFeedbackEffective = hideFeedback || project.status === 'SHARE_ONLY'
  const iconBadgeClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const iconBadgeIconClassName = 'w-4 h-4 text-primary'

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

  const readyVideosForApproval = (project?.videos || []).filter((v: any) => v?.status === 'READY')
  const videosByNameForApproval = (readyVideosForApproval as any[]).reduce(
    (acc: Record<string, any[]>, video: any) => {
    const name = String(video?.name || '')
    if (!name) return acc
    if (!acc[name]) acc[name] = []
    acc[name].push(video)
    return acc
    },
    {} as Record<string, any[]>
  )

  const allVideosHaveApprovedVersion = Object.values(videosByNameForApproval).every((versions) =>
    versions.some((v) => Boolean((v as any)?.approved))
  )

  const canApproveProject = readyVideosForApproval.length > 0 && allVideosHaveApprovedVersion

  const setProjectStatus = async (nextStatus: string) => {
    if (!project || isUpdatingStatus) return
    if (!canChangeProjectStatuses) return
    setIsUpdatingStatus(true)
    try {
      await apiPatch(`/api/projects/${id}`, { status: nextStatus })
      setProject((prev: any) => prev ? { ...prev, status: nextStatus } : prev)
    } catch (error) {
      alert('Failed to update project status')
    } finally {
      setIsUpdatingStatus(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/projects">
            <Button variant="ghost" size="default" className="justify-start px-3">
              <ArrowLeft className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Back to Projects</span>
              <span className="sm:hidden">Back</span>
            </Button>
          </Link>
          {canAccessProjectSettings && (
            <Link href={`/admin/projects/${id}/settings`}>
              <Button variant="outline" size="default">
                <Settings className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Project Settings</span>
              </Button>
            </Link>
          )}
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="overflow-hidden lg:col-span-2 order-1">
              <CardHeader>
                <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
                  <div className="min-w-0 flex-1">
	                    <CardTitle className="flex items-center gap-2 break-words">
	                      <span className={iconBadgeClassName}>
	                        <FolderKanban className={iconBadgeIconClassName} />
	                      </span>
	                      <span className="min-w-0 break-words">{project.title}</span>
	                    </CardTitle>
                    <p className="text-sm text-muted-foreground mt-2 break-words">{project.description}</p>
                  </div>
                  <ProjectStatusPicker
                    value={project.status}
                    disabled={isUpdatingStatus || !canChangeProjectStatuses}
                    canApprove={canApproveProject}
                    visibleStatuses={permissions.projectVisibility.statuses}
                    className={isUpdatingStatus ? 'opacity-70' : 'px-3 py-1'}
                    onChange={(next) => setProjectStatus(next)}
                  />
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-sm">
                    <div className="min-w-0">
                      <p className="text-muted-foreground">Client</p>
                      <p className="font-medium break-words">
                        {(() => {
                          const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
                          return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
                        })()}
                      </p>
                      {!project.companyName && project.recipients?.[0]?.name && project.recipients?.[0]?.email && (
                        <p className="text-xs text-muted-foreground break-all">
                          {project.recipients[0].email}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="text-sm">
                    <div className="min-w-0">
                      <p className="text-muted-foreground">Project Created</p>
                      <p className="font-medium tabular-nums">{formatProjectDate(project.createdAt)}</p>
                    </div>
                  </div>

                  <ShareLink
                    shareUrl={shareUrl}
                    disabled={project.status === 'CLOSED'}
                    label={project.status === 'CLOSED' ? 'Share Link - Inaccessible (Project is Closed)' : 'Share Link'}
                  />
                </div>
              </CardContent>
          </Card>

          <div className="space-y-6 min-w-0 order-2 lg:order-3 lg:col-span-1 lg:col-start-3 lg:row-start-1">
            <ProjectActions project={project} videos={project.videos} onRefresh={fetchProject} />
          </div>

          <div className="lg:col-span-2 space-y-6 min-w-0 order-3 lg:order-2 lg:row-start-2">
            <div>
	              <div className="flex items-center justify-between mb-4">
	                <h2 className="text-xl font-semibold flex items-center gap-2">
	                  <span className={iconBadgeClassName}>
	                    <Video className={iconBadgeIconClassName} />
	                  </span>
	                  Videos
	                </h2>
                {project.videos.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSortMode(current => current === 'status' ? 'alphabetical' : 'status')}
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title={sortMode === 'status' ? 'Sort alphabetically' : 'Sort by status'}
                  >
                    <span>{sortMode === 'status' ? 'Status' : 'Alphabetical'}</span>
                    <ArrowUpDown className="w-4 h-4" />
                  </Button>
                )}
              </div>
              <AdminVideoManager
                projectId={project.id}
                videos={project.videos}
                projectStatus={project.status}
                comments={project.comments}
                restrictToLatestVersion={project.restrictCommentsToLatestVersion}
                companyName={companyName}
                onVideoSelect={handleVideoSelect}
                onRefresh={fetchProject}
                sortMode={sortMode}
                maxRevisions={project.maxRevisions}
                enableRevisions={project.enableRevisions}
              />
            </div>
          </div>

          {!hideFeedbackEffective && activeVideos.length > 0 && (
            <div className="min-w-0 order-4 lg:order-3 lg:col-span-1 lg:col-start-3 lg:row-start-2">
              <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
                <CommentSection
                  key={activeVideoName} // Force fresh component per video
                  projectId={project.id}
                  projectSlug={project.slug}
                  comments={filteredComments}
                  clientName={(() => {
                    const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
                    return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
                  })()}
                  clientEmail={project.recipients?.[0]?.email}
                  isApproved={project.status === 'APPROVED'}
                  restrictToLatestVersion={project.restrictCommentsToLatestVersion}
                  videos={activeVideos}
                  isAdminView={true}
                  companyName={companyName}
                  clientCompanyName={project.companyName}
                  smtpConfigured={true}
                  isPasswordProtected={!!project.sharePassword}
                  adminUser={adminUser}
                  recipients={project.recipients || []}
                  allowClientDeleteComments={project.allowClientDeleteComments}
                  showVideoActions={false}
                  showVideoNotes={false}
                  hideInput={true}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
