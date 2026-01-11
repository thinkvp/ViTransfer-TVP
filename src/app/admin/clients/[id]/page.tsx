'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Save } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, apiPatch } from '@/lib/api-client'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'
import { ClientFileUpload } from '@/components/ClientFileUpload'
import { ClientFileList } from '@/components/ClientFileList'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'

type ClientResponse = {
  id: string
  name: string
  active: boolean
  address: string | null
  phone: string | null
  website: string | null
  notes: string | null
  recipients: Array<{
    id: string
    name: string | null
    email: string | null
    displayColor: string | null
    isPrimary: boolean
    receiveNotifications: boolean
  }>
}

type ClientProjectRow = {
  id: string
  title: string
  status: string
  createdAt: string | Date
  updatedAt: string | Date
  videos: any[]
  _count: { comments: number }
}

type ProjectSortKey = 'title' | 'status' | 'videos' | 'versions' | 'comments' | 'createdAt' | 'updatedAt'
type ProjectSortDirection = 'asc' | 'desc'

export default function ClientDetailPage() {
  const params = useParams()
  const router = useRouter()
  const clientId = params?.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  const [error, setError] = useState('')

  const [client, setClient] = useState<ClientResponse | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    website: '',
    notes: '',
  })

  const [recipients, setRecipients] = useState<EditableRecipient[]>([])
  const [fileRefresh, setFileRefresh] = useState(0)

  const [clientProjects, setClientProjects] = useState<ClientProjectRow[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState('')
  const [projectsSortKey, setProjectsSortKey] = useState<ProjectSortKey>('createdAt')
  const [projectsSortDirection, setProjectsSortDirection] = useState<ProjectSortDirection>('desc')
  const [projectsIsMobile, setProjectsIsMobile] = useState(false)
  const [expandedProjectRows, setExpandedProjectRows] = useState<Record<string, boolean>>({})
  const [projectsPage, setProjectsPage] = useState(1)

  const projectsPageSize = 10

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setProjectsIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const loadClient = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/api/clients/${clientId}`)
      if (!res.ok) {
        if (res.status === 404) {
          router.push('/admin/clients')
          return
        }
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch client')
      }

      const data = await res.json()
      const nextClient = data?.client as ClientResponse
      setClient(nextClient)
      setFormData({
        name: nextClient?.name || '',
        address: nextClient?.address || '',
        phone: nextClient?.phone || '',
        website: nextClient?.website || '',
        notes: nextClient?.notes || '',
      })
      setRecipients(
        (nextClient?.recipients || []).map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          displayColor: r.displayColor ?? null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: r.receiveNotifications !== false,
        }))
      )
    } catch (err: any) {
      setError(err?.message || 'Failed to load client')
    } finally {
      setLoading(false)
    }
  }, [clientId, router])

  const handleToggleActive = useCallback(
    async (nextActive: boolean) => {
      if (!client) return
      setError('')
      setTogglingActive(true)

      const prevClient = client
      setClient({ ...client, active: nextActive })

      try {
        await apiPatch(`/api/clients/${clientId}`, { active: nextActive })
      } catch (err: any) {
        setClient(prevClient)
        setError(err?.message || 'Failed to update client')
      } finally {
        setTogglingActive(false)
      }
    },
    [client, clientId]
  )

  useEffect(() => {
    void loadClient()
  }, [loadClient])

  const loadClientProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectsError('')
    try {
      const res = await apiFetch(`/api/clients/${clientId}/projects`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch client projects')
      }
      const data = await res.json()
      setClientProjects((data?.projects || []) as ClientProjectRow[])
    } catch (err: any) {
      setProjectsError(err?.message || 'Failed to load client projects')
      setClientProjects([])
    } finally {
      setProjectsLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    void loadClientProjects()
  }, [loadClientProjects])

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

  const getUniqueVideosCount = (project: ClientProjectRow) => {
    const set = new Set<string>()
    for (const v of project.videos || []) {
      const name = String((v as any)?.name || '')
      if (name) set.add(`name:${name}`)
      else set.add(`id:${String((v as any)?.id || '')}`)
    }
    return set.size
  }

  const getVersionsCount = (project: ClientProjectRow) => (project.videos || []).length

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

  const sortedClientProjects = useMemo(() => {
    const dir = projectsSortDirection === 'asc' ? 1 : -1
    const list = [...clientProjects]

    list.sort((a, b) => {
      if (projectsSortKey === 'title') return dir * a.title.localeCompare(b.title)
      if (projectsSortKey === 'status') return dir * (getStatusRank(String(a.status)) - getStatusRank(String(b.status)))
      if (projectsSortKey === 'videos') return dir * (getUniqueVideosCount(a) - getUniqueVideosCount(b))
      if (projectsSortKey === 'versions') return dir * (getVersionsCount(a) - getVersionsCount(b))
      if (projectsSortKey === 'comments') return dir * ((a._count?.comments || 0) - (b._count?.comments || 0))
      if (projectsSortKey === 'createdAt') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      if (projectsSortKey === 'updatedAt') return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      return 0
    })

    return list
  }, [clientProjects, projectsSortDirection, projectsSortKey])

  const projectsTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(sortedClientProjects.length / projectsPageSize))
  }, [sortedClientProjects.length])

  useEffect(() => {
    setProjectsPage(1)
  }, [projectsSortKey, projectsSortDirection, clientId])

  useEffect(() => {
    setProjectsPage((p) => Math.min(Math.max(1, p), projectsTotalPages))
  }, [projectsTotalPages])

  const pagedClientProjects = useMemo(() => {
    const start = (projectsPage - 1) * projectsPageSize
    return sortedClientProjects.slice(start, start + projectsPageSize)
  }, [projectsPage, sortedClientProjects])

  const toggleProjectsSort = (key: ProjectSortKey) => {
    setProjectsSortKey((prev) => {
      if (prev === key) {
        setProjectsSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setProjectsSortDirection(key === 'createdAt' ? 'desc' : 'asc')
      return key
    })
  }

  const canRender = useMemo(() => !loading && !!client, [loading, client])

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!client) return

    setError('')
    if (!formData.name.trim()) {
      setError('Client name is required')
      return
    }

    setSaving(true)
    try {
      await apiPatch(`/api/clients/${clientId}`, {
        name: formData.name.trim(),
        address: formData.address.trim() ? formData.address.trim() : null,
        phone: formData.phone.trim() ? formData.phone.trim() : null,
        website: formData.website.trim() ? formData.website.trim() : null,
        notes: formData.notes.trim() ? formData.notes.trim() : null,
        recipients: recipients.map((r) => ({
          id: r.id,
          name: r.name?.trim() ? r.name.trim() : null,
          email: r.email?.trim() ? r.email.trim() : null,
          displayColor: r.displayColor ?? null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: Boolean(r.receiveNotifications),
        })),
      })

      await loadClient()
    } catch (err: any) {
      setError(err?.message || 'Failed to save client')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!client) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Client not found</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/clients">
            <Button variant="ghost" size="default" className="justify-start px-3">
              <ArrowLeft className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Back to Clients</span>
              <span className="sm:hidden">Back</span>
            </Button>
          </Link>
        </div>

        <div className="max-w-5xl mx-auto space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>Client Details</CardTitle>
                <CardDescription>Update client contact information</CardDescription>
              </div>
              <div className="flex items-center justify-end gap-2 shrink-0">
                <span className="text-sm text-muted-foreground">Active</span>
                <Switch
                  checked={Boolean(client.active)}
                  disabled={saving || togglingActive}
                  onCheckedChange={(checked) => void handleToggleActive(checked)}
                  aria-label="Toggle client active"
                />
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-6">
                {error && (
                  <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">Client Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    required
                    maxLength={200}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="address">Address</Label>
                  <Textarea
                    id="address"
                    value={formData.address}
                    onChange={(e) => setFormData((p) => ({ ...p, address: e.target.value }))}
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      value={formData.phone}
                      onChange={(e) => setFormData((p) => ({ ...p, phone: e.target.value }))}
                      maxLength={50}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="website">Website</Label>
                    <Input
                      id="website"
                      value={formData.website}
                      onChange={(e) => setFormData((p) => ({ ...p, website: e.target.value }))}
                      maxLength={200}
                      placeholder="https://"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
                    rows={4}
                  />
                </div>

                <div className="border rounded-lg p-4 bg-card">
                  <RecipientsEditor
                    label="Client Recipients"
                    description="Recipients can be pulled into projects during project creation"
                    value={recipients}
                    onChange={setRecipients}
                    addButtonLabel="Add Recipient"
                    showNotificationsToggle={false}
                  />
                </div>

                <div className="flex items-center justify-end">
                  <Button type="submit" disabled={saving}>
                    <Save className="w-4 h-4 mr-2" />
                    Save Changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
              <CardDescription>Store contracts, brand assets and more</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ClientFileUpload
                clientId={clientId}
                onUploadComplete={() => setFileRefresh((v) => v + 1)}
              />
              <ClientFileList clientId={clientId} refreshTrigger={fileRefresh} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Projects</CardTitle>
              <CardDescription>Projects assigned to this client</CardDescription>
            </CardHeader>
            <CardContent>
              {projectsError && (
                <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
                  {projectsError}
                </div>
              )}

              {projectsLoading ? (
                <p className="text-muted-foreground">Loading projects...</p>
              ) : sortedClientProjects.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center">No projects assigned to this client.</div>
              ) : (
                <div className="rounded-md border border-border bg-card overflow-hidden">
                  <div className="w-full overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-8 md:hidden" aria-label="Expand" />
                          {(
                            [
                              { key: 'title', label: 'Project Name', className: 'min-w-[220px]', mobile: true },
                              { key: 'status', label: 'Status', className: 'min-w-[120px]', mobile: true },
                              { key: 'videos', label: 'Videos', className: 'w-[90px] text-right hidden md:table-cell', mobile: false },
                              { key: 'versions', label: 'Versions', className: 'w-[95px] text-right hidden md:table-cell', mobile: false },
                              { key: 'comments', label: 'Comments', className: 'w-[110px] text-right hidden md:table-cell', mobile: false },
                              { key: 'createdAt', label: 'Date Created', className: 'w-[130px] hidden md:table-cell', mobile: false },
                              { key: 'updatedAt', label: 'Last Activity', className: 'w-[130px] hidden md:table-cell', mobile: false },
                            ] as const
                          ).map((col) => (
                            <th
                              key={col.key}
                              scope="col"
                              className={cn('px-3 py-2 text-left text-xs font-medium text-muted-foreground', col.className)}
                            >
                              <button
                                type="button"
                                onClick={() => toggleProjectsSort(col.key)}
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                title="Sort"
                              >
                                <span>{col.label}</span>
                                {projectsSortKey === col.key && (
                                  projectsSortDirection === 'asc'
                                    ? <ArrowUp className="h-3.5 w-3.5" />
                                    : <ArrowDown className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedClientProjects.map((project) => {
                          const uniqueVideos = getUniqueVideosCount(project)
                          const versionsCount = getVersionsCount(project)
                          const commentsCount = project._count?.comments || 0
                          const isExpanded = Boolean(expandedProjectRows[project.id])

                          return (
                            <Fragment key={project.id}>
                              <tr
                                className="border-b border-border last:border-b-0 hover:bg-muted/30 cursor-pointer"
                                onClick={() => router.push(`/admin/projects/${project.id}`)}
                              >
                                <td className="px-2 py-2 md:hidden" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-muted"
                                    aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                                    title={isExpanded ? 'Collapse' : 'Expand'}
                                    onClick={() =>
                                      setExpandedProjectRows((prev) => ({
                                        ...prev,
                                        [project.id]: !prev[project.id],
                                      }))
                                    }
                                  >
                                    <ChevronRight className={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-90')} />
                                  </button>
                                </td>

                                <td className="px-3 py-2 font-medium">
                                  <div className="min-w-0">
                                    <div className="truncate">{project.title}</div>
                                    <div className="md:hidden text-xs text-muted-foreground tabular-nums mt-1">
                                      Videos: {uniqueVideos} • Versions: {versionsCount}
                                    </div>
                                  </div>
                                </td>

                                <td className="px-3 py-2">
                                  <span
                                    className={cn(
                                      'px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
                                      projectStatusBadgeClass(String(project.status))
                                    )}
                                  >
                                    {projectStatusLabel(String(project.status))}
                                  </span>
                                </td>

                                <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{uniqueVideos}</td>
                                <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{versionsCount}</td>
                                <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">{commentsCount}</td>
                                <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.createdAt)}</td>
                                <td className="px-3 py-2 tabular-nums hidden md:table-cell">{formatProjectDate(project.updatedAt)}</td>
                              </tr>

                              {projectsIsMobile && isExpanded && (
                                <tr className="md:hidden border-b border-border last:border-b-0">
                                  <td
                                    colSpan={3}
                                    className="px-3 py-2 bg-muted/40 dark:bg-muted/10"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="space-y-1 text-sm">
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
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {sortedClientProjects.length > projectsPageSize && (
                    <div className="flex items-center justify-end gap-2 px-3 py-3 border-t border-border">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={projectsPage <= 1}
                        onClick={() => setProjectsPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        Page {projectsPage} of {projectsTotalPages}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={projectsPage >= projectsTotalPages}
                        onClick={() => setProjectsPage((p) => Math.min(projectsTotalPages, p + 1))}
                      >
                        Next
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
