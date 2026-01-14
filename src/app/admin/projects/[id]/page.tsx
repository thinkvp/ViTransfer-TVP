'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import AdminVideoManager from '@/components/AdminVideoManager'
import AdminAlbumManager from '@/components/AdminAlbumManager'
import ProjectActions from '@/components/ProjectActions'
import ShareLink from '@/components/ShareLink'
import { ArrowLeft, Settings, ArrowUpDown, FolderKanban, Video, Images } from 'lucide-react'
import { apiDelete, apiFetch, apiPatch, apiPost } from '@/lib/api-client'
import ProjectStatusPicker from '@/components/ProjectStatusPicker'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { ProjectUsersEditor, type AssignableUser } from '@/components/ProjectUsersEditor'
import { ProjectFileUpload } from '@/components/ProjectFileUpload'
import { ProjectFileList } from '@/components/ProjectFileList'
import { ProjectStorageUsage } from '@/components/ProjectStorageUsage'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'
import { ProjectInternalComments } from '@/components/ProjectInternalComments'
import { getSalesSettings, listInvoices, listQuotes } from '@/lib/sales/local-store'
import { centsToDollars, sumLineItemsTotal } from '@/lib/sales/money'

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
  const [sortMode, setSortMode] = useState<'status' | 'alphabetical'>('alphabetical')
  const [adminUser, setAdminUser] = useState<any>(null)
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false)
  const [assignedUsers, setAssignedUsers] = useState<AssignableUser[]>([])
  const [projectFilesRefresh, setProjectFilesRefresh] = useState(0)

  const [editableRecipients, setEditableRecipients] = useState<EditableRecipient[]>([])
  const [clientRecipients, setClientRecipients] = useState<Array<{ id?: string; name: string | null; email: string | null; displayColor?: string | null }>>([])
  const [projectClientName, setProjectClientName] = useState<string | null>(null)

  const permissions = useMemo(() => normalizeRolePermissions(adminUser?.permissions), [adminUser?.permissions])
  const canAccessProjectSettings = canDoAction(permissions, 'accessProjectSettings')
  const canChangeProjectStatuses = canDoAction(permissions, 'changeProjectStatuses')
  const canChangeProjectSettings = canDoAction(permissions, 'changeProjectSettings')
  const canUploadFilesToProjectInternal = canDoAction(permissions, 'uploadFilesToProjectInternal')
  const canMakeProjectComments = canDoAction(permissions, 'makeCommentsOnProjects')

  const salesSettings = useMemo(() => getSalesSettings(), [])
  const projectQuotes = useMemo(() => {
    if (!project?.id) return []
    return listQuotes().filter((q) => q.projectId === project.id)
  }, [project?.id])

  const projectInvoices = useMemo(() => {
    if (!project?.id) return []
    return listInvoices().filter((inv) => inv.projectId === project.id)
  }, [project?.id])

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
      setAssignedUsers(Array.isArray((data as any)?.assignedUsers) ? ((data as any).assignedUsers as AssignableUser[]) : [])

      const recipients = Array.isArray((data as any)?.recipients) ? ((data as any).recipients as any[]) : []
      setEditableRecipients(
        recipients.map((r) => ({
          id: String(r?.id || ''),
          name: r?.name ?? null,
          email: r?.email ?? null,
          displayColor: r?.displayColor ?? null,
          isPrimary: Boolean(r?.isPrimary),
          receiveNotifications: r?.receiveNotifications !== false,
        }))
      )
    } catch (error) {
      console.error('Error fetching project:', error)
    } finally {
      setLoading(false)
    }
  }, [id, router])

  const persistRecipients = useCallback(async (next: EditableRecipient[]) => {
    if (!canChangeProjectSettings) return
    setEditableRecipients(next)

    try {
      const prevIds = new Set(editableRecipients.map((r) => String(r.id || '')).filter(Boolean))
      const nextIds = new Set(next.map((r) => String(r.id || '')).filter(Boolean))

      // Deletions
      const toDelete = Array.from(prevIds).filter((rid) => !nextIds.has(rid))
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map((rid) => apiDelete(`/api/projects/${id}/recipients/${rid}`)))
      }

      // Updates
      const toUpdate = next.filter((r) => r.id)
      if (toUpdate.length > 0) {
        await Promise.all(
          toUpdate.map((r) => {
            const rid = String(r.id || '')
            return apiPatch(`/api/projects/${id}/recipients/${rid}`, {
              name: r.name?.trim() ? r.name.trim() : null,
              email: r.email?.trim() ? r.email.trim() : null,
              displayColor: r.displayColor ?? null,
              isPrimary: Boolean(r.isPrimary),
              receiveNotifications: Boolean(r.receiveNotifications),
            })
          })
        )
      }

      // Creations (no id)
      const toCreate = next.filter((r) => !r.id)
      if (toCreate.length > 0) {
        for (const r of toCreate) {
          await apiPost(`/api/projects/${id}/recipients`, {
            name: r.name?.trim() ? r.name.trim() : null,
            email: r.email?.trim() ? r.email.trim() : null,
            displayColor: r.displayColor ?? null,
            isPrimary: Boolean(r.isPrimary),
            receiveNotifications: Boolean(r.receiveNotifications),
            alsoAddToClient: Boolean((r as any)?.alsoAddToClient),
          })
        }
      }

      fetchProject()
    } catch (e: any) {
      alert(e?.message || 'Failed to update recipients')
      fetchProject()
    }
  }, [canChangeProjectSettings, editableRecipients, fetchProject, id])

  const persistAssignedUsers = useCallback(async (next: AssignableUser[]) => {
    try {
      await apiPatch(`/api/projects/${id}`, {
        assignedUsers: next.map((u) => ({
          userId: u.id,
          receiveNotifications: u.receiveNotifications !== false,
        })),
      })
    } catch {
      alert('Failed to update assigned users')
    } finally {
      fetchProject()
    }
  }, [fetchProject, id])

  // Fetch project data on mount
  useEffect(() => {
    fetchProject()
  }, [fetchProject])

  // Listen for immediate updates (approval changes, comment deletes/posts, etc.)
  useEffect(() => {
    const handleUpdate = () => fetchProject()

    window.addEventListener('videoApprovalChanged', handleUpdate)

    return () => {
      window.removeEventListener('videoApprovalChanged', handleUpdate)
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

  // Fetch client recipients (for picker) when client changes
  useEffect(() => {
    if (!project?.clientId) {
      setClientRecipients([])
      setProjectClientName(null)
      return
    }

    let cancelled = false
    async function fetchClientRecipients() {
      try {
        const response = await apiFetch(`/api/clients/${project.clientId}`)
        if (!response.ok) return
        const data = await response.json()
        const clientName = typeof data?.client?.name === 'string' ? data.client.name : null
        const recips = Array.isArray(data?.client?.recipients) ? data.client.recipients : []
        if (!cancelled) {
          setClientRecipients(recips)
          setProjectClientName(clientName)
        }
      } catch {
        // ignore
      }
    }

    fetchClientRecipients()
    return () => {
      cancelled = true
    }
  }, [project?.clientId])

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

  const handleVideoSelect = (_videoName: string, _videos: any[]) => {}

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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-6 min-w-0">
            <Card className="overflow-hidden">
              <CardHeader>
                <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
                  <div className="min-w-0 flex-1">
	                    <CardTitle className="flex items-center gap-2 break-words">
	                      <span className={iconBadgeClassName}>
	                        <FolderKanban className={iconBadgeIconClassName} />
	                      </span>
	                      <span className="min-w-0 break-words">{project.title}</span>
	                    </CardTitle>
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
                  <div className="flex items-start justify-between gap-4">
                    <div className="text-sm min-w-0">
                      <p className="text-muted-foreground">Client</p>
                      <p className="font-medium break-words">
                        {(() => {
                          const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
                          const label = project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
                          return project.clientId
                            ? <Link href={`/admin/clients/${project.clientId}`} className="hover:underline">{label}</Link>
                            : label
                        })()}
                      </p>
                      {!project.companyName && project.recipients?.[0]?.name && project.recipients?.[0]?.email && (
                        <p className="text-xs text-muted-foreground break-all">
                          {project.recipients[0].email}
                        </p>
                      )}
                    </div>

                    <div className="text-sm flex-shrink-0 text-right">
                      <p className="text-muted-foreground">Project Created</p>
                      <p className="font-medium tabular-nums">{formatProjectDate(project.createdAt)}</p>
                    </div>
                  </div>

                  {String(project.description || '').trim().length > 0 && (
                    <div className="text-sm">
                      <p className="text-muted-foreground">Project Description</p>
                      <div className="mt-1 text-sm text-foreground whitespace-pre-wrap break-words">{project.description}</div>
                    </div>
                  )}

                  <ShareLink
                    shareUrl={shareUrl}
                    disabled={project.status === 'CLOSED'}
                    label={project.status === 'CLOSED' ? 'Share Link - Inaccessible (Project is Closed)' : 'Share Link'}
                  />

                  {/* Recipients: full row */}
                  <div className="border rounded-lg p-4 bg-card">
                    <RecipientsEditor
                      label="Recipients"
                      description=""
                      value={editableRecipients}
                      onChange={(next) => void persistRecipients(next)}
                      addButtonLabel="Add Recipient"
                      showNotificationsToggle={true}
                      showDisplayColor={true}
                      showAlsoAddToClient={Boolean(project?.clientId)}
                      addMode="dialog"
                      clientRecipients={clientRecipients}
                      clientName={projectClientName || undefined}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {(projectQuotes.length > 0 || projectInvoices.length > 0) && (
              <Card>
                <CardContent className="pt-6 space-y-6">
                  {projectQuotes.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Quotes</div>
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/30 text-xs text-muted-foreground">
                            <tr className="text-left">
                              <th className="px-3 py-2">Quote</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2 text-right">Amount (inc tax)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {projectQuotes.slice(0, 5).map((q: any) => {
                              const totalCents = sumLineItemsTotal(Array.isArray(q.items) ? q.items : [], salesSettings.taxRatePercent)
                              return (
                                <tr key={q.id} className="border-t">
                                  <td className="px-3 py-2">
                                    <Link href={`/admin/sales/quotes/${q.id}`} className="font-medium hover:underline">
                                      {q.quoteNumber}
                                    </Link>
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                                      {q.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">${centsToDollars(totalCents)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {projectInvoices.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Invoices</div>
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/30 text-xs text-muted-foreground">
                            <tr className="text-left">
                              <th className="px-3 py-2">Invoice</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2 text-right">Amount (inc tax)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {projectInvoices.slice(0, 5).map((inv: any) => {
                              const totalCents = sumLineItemsTotal(Array.isArray(inv.items) ? inv.items : [], salesSettings.taxRatePercent)
                              return (
                                <tr key={inv.id} className="border-t">
                                  <td className="px-3 py-2">
                                    <Link href={`/admin/sales/invoices/${inv.id}`} className="font-medium hover:underline">
                                      {inv.invoiceNumber}
                                    </Link>
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                                      {inv.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">${centsToDollars(totalCents)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {project.enableVideos !== false && (
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
            )}

            {project.enablePhotos !== false && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <span className={iconBadgeClassName}>
                      <Images className={iconBadgeIconClassName} />
                    </span>
                    Photos
                  </h2>
                </div>
                <AdminAlbumManager projectId={project.id} projectStatus={project.status} />
              </div>
            )}
          </div>

          <div className="space-y-6 min-w-0">
            <ProjectActions project={project} videos={project.videos} onRefresh={fetchProject} />

            <ProjectInternalComments
              projectId={project.id}
              currentUserId={adminUser?.id || null}
              canMakeComments={canMakeProjectComments}
              canDeleteAll={adminUser?.appRoleIsSystemAdmin === true}
            />

            <Card>
              <CardContent className="pt-6">
                <ProjectUsersEditor
                  label="Users"
                  description="Add internal users"
                  value={assignedUsers}
                  onChange={(next) => {
                    setAssignedUsers(next)
                    void persistAssignedUsers(next)
                  }}
                  disabled={!canChangeProjectSettings}
                  addButtonLabel="Add Users"
                  addButtonSize="default"
                  addButtonVariant="outline"
                />
              </CardContent>
            </Card>

            <div className="border rounded-lg p-4 bg-card space-y-4">
              {canUploadFilesToProjectInternal ? (
                <ProjectFileUpload
                  title="Project Files"
                  description="Internal use only"
                  layout="headerRow"
                  projectId={project.id}
                  maxConcurrent={3}
                  onUploadComplete={() => setProjectFilesRefresh((v) => v + 1)}
                />
              ) : (
                <div>
                  <div className="text-base font-medium">Project Files</div>
                  <p className="text-xs text-muted-foreground mt-1">Internal use only</p>
                </div>
              )}

              <ProjectFileList
                projectId={project.id}
                refreshTrigger={projectFilesRefresh}
                canDelete={canUploadFilesToProjectInternal}
              />
            </div>

            <ProjectStorageUsage projectId={project.id} />
          </div>
        </div>
      </div>
    </div>
  )
}
