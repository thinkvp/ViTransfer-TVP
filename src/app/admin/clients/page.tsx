'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Building2, Plus, Trash2, ArrowUp, ArrowDown, Filter } from 'lucide-react'
import { apiDelete, apiFetch, apiPatch } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface ClientRow {
  id: string
  name: string
  active: boolean
  contacts: number
  projects: number
  primaryContact: string | null
  primaryEmail: string | null
}

type SortKey = 'name' | 'primaryContact' | 'primaryEmail'

type SortDirection = 'asc' | 'desc'

type ActiveFilter = 'all' | 'active' | 'inactive'

export default function ClientsPage() {
  const router = useRouter()
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [searchQuery, setSearchQuery] = useState('')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)

  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('active')
  const [updatingClientIds, setUpdatingClientIds] = useState<Set<string>>(new Set())

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const loadClients = useCallback(async (nextActiveFilter: ActiveFilter) => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/api/clients?active=${encodeURIComponent(nextActiveFilter)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch clients')
      }
      const data = await res.json()
      setClients(data.clients || [])
    } catch (e: any) {
      setError(e?.message || 'Failed to load clients')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadClients(activeFilter)
  }, [activeFilter, loadClients])

  const isActiveFilterApplied = activeFilter !== 'all'

  const setClientActive = async (clientId: string, nextActive: boolean) => {
    setError('')
    setUpdatingClientIds((prev) => new Set(prev).add(clientId))

    const prevClients = clients
    setClients((prev) => prev.map((c) => (c.id === clientId ? { ...c, active: nextActive } : c)))

    try {
      await apiPatch(`/api/clients/${clientId}`, { active: nextActive })
    } catch (e: any) {
      setClients(prevClients)
      setError(e?.message || 'Failed to update client')
    } finally {
      setUpdatingClientIds((prev) => {
        const next = new Set(prev)
        next.delete(clientId)
        return next
      })
    }
  }

  const sortedClients = useMemo(() => {
    const dir = sortDirection === 'asc' ? 1 : -1
    const safe = (v: string | null | undefined) => (v || '').toLowerCase()

    return [...clients].sort((a, b) => {
      if (sortKey === 'name') return dir * safe(a.name).localeCompare(safe(b.name))
      if (sortKey === 'primaryContact') return dir * safe(a.primaryContact).localeCompare(safe(b.primaryContact))
      return dir * safe(a.primaryEmail).localeCompare(safe(b.primaryEmail))
    })
  }, [clients, sortDirection, sortKey])

  const filteredClients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedClients
    const safe = (v: string | null | undefined) => String(v || '').toLowerCase()
    return sortedClients.filter((c) => {
      return (
        safe(c.name).includes(q) ||
        safe(c.primaryContact).includes(q) ||
        safe(c.primaryEmail).includes(q)
      )
    })
  }, [searchQuery, sortedClients])

  const tableTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredClients.length / recordsPerPage))
  }, [filteredClients.length, recordsPerPage])

  useEffect(() => {
    setTablePage(1)
  }, [activeFilter, recordsPerPage, searchQuery])

  useEffect(() => {
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages])

  const pageClients = useMemo(() => {
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return filteredClients.slice(start, end)
  }, [filteredClients, recordsPerPage, tablePage])

  const toggleSort = (key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDirection('asc')
      return key
    })
  }

  const handleDelete = async (clientId: string, clientName: string) => {
    if (!confirm(`Delete client "${clientName}"?`)) return

    try {
      await apiDelete(`/api/clients/${clientId}`)
      setClients((prev) => prev.filter((c) => c.id !== clientId))
    } catch (e: any) {
      alert(e?.message || 'Failed to delete client')
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading clients...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="w-full max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="flex justify-between items-center gap-4 mb-4 sm:mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
              <Building2 className="w-7 h-7 sm:w-8 sm:h-8" />
              Clients
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage client details, recipients, and files.</p>
          </div>
          <Button variant="default" size="default" onClick={() => router.push('/admin/clients/new')}>
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Add New Client</span>
          </Button>
        </div>

        {error && (
          <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {clients.length > 0 && (
          <div className="flex flex-nowrap items-center justify-between gap-2 mb-3">
            <div className="flex-1 min-w-0 sm:flex-1 sm:max-w-sm">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search clients..."
                className="h-9"
                aria-label="Search clients"
              />
            </div>

            <div className="flex items-center justify-end gap-2 flex-shrink-0">
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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant={isActiveFilterApplied ? 'default' : 'ghost'}
                    size="sm"
                    className={cn(
                      'inline-flex items-center',
                      isActiveFilterApplied ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Filter clients"
                    title="Filter clients"
                  >
                    <Filter className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Filter clients</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem checked={activeFilter === 'all'} onCheckedChange={() => setActiveFilter('all')}>
                    All
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={activeFilter === 'active'} onCheckedChange={() => setActiveFilter('active')}>
                    Active
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={activeFilter === 'inactive'} onCheckedChange={() => setActiveFilter('inactive')}>
                    Inactive
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {filteredClients.length === 0 ? (
          <div className="rounded-md border border-border bg-card">
            <div className="py-10 text-center text-muted-foreground">No clients found.</div>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-card overflow-hidden">
            <div className="w-full overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                    <thead className="bg-muted/40">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                          <button
                            type="button"
                            onClick={() => toggleSort('name')}
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            title="Sort"
                          >
                            <span>Client Name</span>
                            {sortKey === 'name' &&
                              (sortDirection === 'asc' ? (
                                <ArrowUp className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDown className="h-3.5 w-3.5" />
                              ))}
                          </button>
                        </th>

                        <th scope="col" className="px-3 py-2 text-center text-xs font-medium text-muted-foreground w-[96px] hidden sm:table-cell">
                          Projects
                        </th>

                        <th scope="col" className="px-3 py-2 text-center text-xs font-medium text-muted-foreground w-[96px] hidden sm:table-cell">
                          Contacts
                        </th>

                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground hidden md:table-cell">
                          <button
                            type="button"
                            onClick={() => toggleSort('primaryContact')}
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            title="Sort"
                          >
                            <span>Primary Contact</span>
                            {sortKey === 'primaryContact' &&
                              (sortDirection === 'asc' ? (
                                <ArrowUp className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDown className="h-3.5 w-3.5" />
                              ))}
                          </button>
                        </th>

                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground hidden md:table-cell">
                          <button
                            type="button"
                            onClick={() => toggleSort('primaryEmail')}
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            title="Sort"
                          >
                            <span>Primary Email</span>
                            {sortKey === 'primaryEmail' &&
                              (sortDirection === 'asc' ? (
                                <ArrowUp className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDown className="h-3.5 w-3.5" />
                              ))}
                          </button>
                        </th>

                        <th scope="col" className="px-2 sm:px-3 py-2 text-center text-xs font-medium text-muted-foreground w-[76px] sm:w-[84px]">
                          Active
                        </th>

                        <th scope="col" className="px-2 sm:px-3 py-2 text-center text-xs font-medium text-muted-foreground w-[64px] sm:w-[72px]">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageClients.map((client) => (
                        <tr
                          key={client.id}
                          className="border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer"
                          onClick={() => router.push(`/admin/clients/${client.id}`)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              router.push(`/admin/clients/${client.id}`)
                            }
                          }}
                        >
                          <td className="px-3 py-3 font-medium truncate">
                            {client.name}
                          </td>
                          <td className="px-3 py-3 text-center text-muted-foreground hidden sm:table-cell">
                            {Number.isFinite(client.projects) ? client.projects : 0}
                          </td>
                          <td className="px-3 py-3 text-center text-muted-foreground hidden sm:table-cell">
                            {Number.isFinite(client.contacts) ? client.contacts : 0}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground hidden md:table-cell truncate">
                            {client.primaryContact || '—'}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground hidden md:table-cell truncate">
                            {client.primaryEmail || '—'}
                          </td>
                          <td className="px-2 sm:px-3 py-3 text-center">
                            <div
                              className="inline-flex items-center justify-center"
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Toggle client active"
                            >
                              <Switch
                                checked={Boolean(client.active)}
                                disabled={updatingClientIds.has(client.id)}
                                onCheckedChange={(checked) => void setClientActive(client.id, checked)}
                              />
                            </div>
                          </td>
                          <td className="px-2 sm:px-3 py-3 whitespace-nowrap text-center">
                            <div className="inline-flex items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                aria-label="Delete client"
                                title="Delete"
                                onPointerDown={(e) => {
                                  e.stopPropagation()
                                }}
                                onMouseDown={(e) => {
                                  e.stopPropagation()
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation()
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void handleDelete(client.id, client.name)
                                }}
                              >
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
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
    </div>
  )
}
