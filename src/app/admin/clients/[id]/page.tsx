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
import { formatDate } from '@/lib/utils'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'
import { ClientFileUpload } from '@/components/ClientFileUpload'
import { ClientFileList } from '@/components/ClientFileList'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'
import { centsToDollars, formatMoney, sumLineItemsTotal } from '@/lib/sales/money'
import type { InvoiceStatus, QuoteStatus, SalesInvoice, SalesQuote } from '@/lib/sales/types'
import { fetchSalesRollup } from '@/lib/sales/admin-api'
import type { SalesRollupPaymentRow, SalesRollupResponse } from '@/lib/sales/admin-api'
import {
  invoiceEffectiveStatus as computeInvoiceEffectiveStatus,
  quoteEffectiveStatus as computeQuoteEffectiveStatus,
} from '@/lib/sales/status'

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
    receiveSalesReminders: boolean
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

function quoteStatusBadgeClass(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'ACCEPTED':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
    case 'CLOSED':
      return 'bg-muted text-muted-foreground border border-border'
  }
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'ACCEPTED':
      return 'Accepted'
    case 'CLOSED':
      return 'Closed'
  }
}

function invoiceStatusBadgeClass(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'OVERDUE':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20'
    case 'PARTIALLY_PAID':
      return 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20'
    case 'PAID':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
  }
}

function invoiceStatusLabel(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'OVERDUE':
      return 'Overdue'
    case 'PARTIALLY_PAID':
      return 'Partially Paid'
    case 'PAID':
      return 'Paid'
  }
}

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

  const [salesTick, setSalesTick] = useState(0)

  const [salesLoading, setSalesLoading] = useState(false)
  const [salesQuotes, setSalesQuotes] = useState<SalesQuote[]>([])
  const [salesInvoices, setSalesInvoices] = useState<SalesInvoice[]>([])
  const [salesPayments, setSalesPayments] = useState<SalesRollupPaymentRow[]>([])
  const [salesTaxRatePercent, setSalesTaxRatePercent] = useState<number>(0)
  const [salesRollup, setSalesRollup] = useState<SalesRollupResponse | null>(null)

  const [extraProjectTitles, setExtraProjectTitles] = useState<Record<string, string>>({})

  const projectsPageSize = 10

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setProjectsIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const onFocus = () => setSalesTick((v) => v + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        setSalesLoading(true)
        const r = await fetchSalesRollup({
          clientId,
          invoicesLimit: 1000,
          quotesLimit: 1000,
          paymentsLimit: 5000,
          stripePaymentsLimit: 500,
          includeInvoices: true,
          includeQuotes: true,
          includePayments: true,
        })

        if (cancelled) return
        setSalesTaxRatePercent(r.taxRatePercent)
        setSalesQuotes(r.quotes)
        setSalesInvoices(r.invoices)
        setSalesPayments(r.payments)
        setSalesRollup(r)
      } finally {
        if (!cancelled) setSalesLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [clientId, salesTick])

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
          receiveSalesReminders: (r as any).receiveSalesReminders !== false,
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

  const projectTitleById = useMemo(() => {
    return Object.fromEntries(clientProjects.map((p) => [p.id, p.title]))
  }, [clientProjects])

  const resolvedProjectTitleById = useMemo(() => {
    return { ...projectTitleById, ...extraProjectTitles }
  }, [extraProjectTitles, projectTitleById])

  const sales = useMemo(() => {
    const quotes = [...salesQuotes]
    const invoices = [...salesInvoices]
    const payments = [...salesPayments]

    const invoiceNumberById = Object.fromEntries(invoices.map((i) => [i.id, i.invoiceNumber]))

    quotes.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    invoices.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    payments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

    return {
      quotes,
      invoices,
      payments,
      invoiceNumberById,
    }
  }, [salesInvoices, salesPayments, salesQuotes])

  const invoicePaidCents = useCallback(
    (inv: SalesInvoice): number => {
      const r = salesRollup?.invoiceRollupById?.[inv.id]
      const paid = Number(r?.paidCents)
      if (Number.isFinite(paid)) return Math.max(0, Math.trunc(paid))
      return sales.payments.filter((p) => p.invoiceId === inv.id).reduce((acc, p) => acc + p.amountCents, 0)
    },
    [sales.payments, salesRollup?.invoiceRollupById]
  )

  const invoiceEffectiveStatus = useCallback(
    (inv: SalesInvoice): InvoiceStatus => {
      const rollupStatus = salesRollup?.invoiceRollupById?.[inv.id]?.effectiveStatus
      if (rollupStatus === 'OPEN' || rollupStatus === 'SENT' || rollupStatus === 'OVERDUE' || rollupStatus === 'PARTIALLY_PAID' || rollupStatus === 'PAID') {
        return rollupStatus
      }
      const totalCents = sumLineItemsTotal(inv.items, salesTaxRatePercent)
      const paidCents = invoicePaidCents(inv)

      return computeInvoiceEffectiveStatus({
        status: inv.status,
        sentAt: inv.sentAt,
        dueDate: inv.dueDate,
        totalCents,
        paidCents,
      })
    },
    [invoicePaidCents, salesRollup?.invoiceRollupById, salesTaxRatePercent]
  )

  const quoteEffectiveStatus = useCallback(
    (q: SalesQuote): QuoteStatus => {
      const rollupStatus = salesRollup?.quoteEffectiveStatusById?.[q.id]
      if (rollupStatus === 'OPEN' || rollupStatus === 'SENT' || rollupStatus === 'ACCEPTED' || rollupStatus === 'CLOSED') {
        return rollupStatus
      }
      return computeQuoteEffectiveStatus(q)
    },
    [salesRollup?.quoteEffectiveStatusById]
  )

  useEffect(() => {
    const idsToFetch = new Set<string>()

    for (const q of sales.quotes) {
      if (!q.projectId) continue
      if (resolvedProjectTitleById[q.projectId]) continue
      idsToFetch.add(q.projectId)
    }

    for (const inv of sales.invoices) {
      if (!inv.projectId) continue
      if (resolvedProjectTitleById[inv.projectId]) continue
      idsToFetch.add(inv.projectId)
    }

    const ids = Array.from(idsToFetch).slice(0, 25)
    if (ids.length === 0) return

    let cancelled = false

    void (async () => {
      const next: Record<string, string> = {}

      await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`)
            if (!res.ok) return
            const data: any = await res.json().catch(() => null)
            const title = String(data?.title || data?.project?.title || '').trim()
            if (title) next[id] = title
          } catch {
            // ignore
          }
        })
      )

      if (cancelled) return
      if (Object.keys(next).length === 0) return
      setExtraProjectTitles((prev) => ({ ...prev, ...next }))
    })()

    return () => {
      cancelled = true
    }
  }, [resolvedProjectTitleById, sales.invoices, sales.quotes])

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
          receiveSalesReminders: (r as any)?.receiveSalesReminders !== false,
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

                <RecipientsEditor
                  label="Client Recipients"
                  value={recipients}
                  onChange={setRecipients}
                  addButtonLabel="Add Recipient"
                  addButtonVariant="outline"
                  addButtonSize="default"
                  addButtonHideLabelOnMobile={true}
                  addButtonFixedWidth={false}
                  showNotificationsToggle={false}
                  showSalesRemindersToggle
                />

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

          <Card>
            <CardHeader>
              <CardTitle>Sales</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Quotes</div>
                  <Link href="/admin/sales/quotes" className="text-sm text-muted-foreground hover:underline">View all</Link>
                </div>
                {sales.quotes.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{salesLoading ? 'Loading…' : 'No quotes for this client yet.'}</div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Quote</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Issue date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Project</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sales.quotes.slice(0, 10).map((q) => {
                          const effectiveStatus = quoteEffectiveStatus(q)
                          return (
                            <tr key={q.id} className="border-b border-border/60 last:border-b-0">
                              <td className="px-3 py-2 font-medium">
                                <Link href={`/admin/sales/quotes/${q.id}`} className="hover:underline">
                                  {q.quoteNumber}
                                </Link>
                              </td>
                              <td className="px-3 py-2 tabular-nums">{formatDate(q.issueDate)}</td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {q.projectId ? (
                                  <Link href={`/admin/projects/${q.projectId}`} className="hover:underline">
                                    {resolvedProjectTitleById[q.projectId] ?? q.projectId}
                                  </Link>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={cn(
                                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
                                    quoteStatusBadgeClass(effectiveStatus)
                                  )}
                                >
                                  {quoteStatusLabel(effectiveStatus)}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Invoices</div>
                  <Link href="/admin/sales/invoices" className="text-sm text-muted-foreground hover:underline">View all</Link>
                </div>
                {sales.invoices.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{salesLoading ? 'Loading…' : 'No invoices for this client yet.'}</div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Issue date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Due date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Project</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sales.invoices.slice(0, 10).map((inv) => {
                          const effectiveStatus = invoiceEffectiveStatus(inv)
                          return (
                          <tr key={inv.id} className="border-b border-border/60 last:border-b-0">
                            <td className="px-3 py-2 font-medium">
                              <Link href={`/admin/sales/invoices/${inv.id}`} className="hover:underline">
                                {inv.invoiceNumber}
                              </Link>
                            </td>
                            <td className="px-3 py-2 tabular-nums">{formatDate(inv.issueDate)}</td>
                            <td className="px-3 py-2 tabular-nums">{inv.dueDate ? formatDate(inv.dueDate) : '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {inv.projectId ? (
                                <Link href={`/admin/projects/${inv.projectId}`} className="hover:underline">
                                  {resolvedProjectTitleById[inv.projectId] ?? inv.projectId}
                                </Link>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={cn(
                                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
                                  invoiceStatusBadgeClass(effectiveStatus)
                                )}
                              >
                                {invoiceStatusLabel(effectiveStatus)}
                              </span>
                            </td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Payments</div>
                  <Link href="/admin/sales/payments" className="text-sm text-muted-foreground hover:underline">View all</Link>
                </div>
                {sales.payments.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{salesLoading ? 'Loading…' : 'No payments for this client yet.'}</div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Amount</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Method</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sales.payments.slice(0, 10).map((p) => (
                          <tr key={p.id} className="border-b border-border/60 last:border-b-0">
                            <td className="px-3 py-2 tabular-nums">{formatDate(p.paymentDate)}</td>
                            <td className="px-3 py-2 font-medium">{formatMoney(p.amountCents)}</td>
                            <td className="px-3 py-2 text-muted-foreground">{p.method || '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {p.invoiceId ? (
                                <Link href={`/admin/sales/invoices/${p.invoiceId}`} className="hover:underline">
                                  {sales.invoiceNumberById[p.invoiceId] ?? p.invoiceId}
                                </Link>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
