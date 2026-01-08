'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Building2, Plus, Edit, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface ClientRow {
  id: string
  name: string
  contacts: number
  primaryContact: string | null
  primaryEmail: string | null
}

type SortKey = 'name' | 'primaryContact' | 'primaryEmail'

type SortDirection = 'asc' | 'desc'

export default function ClientsPage() {
  const router = useRouter()
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  async function loadClients() {
    setError('')
    try {
      const res = await apiFetch('/api/clients')
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
  }

  useEffect(() => {
    void loadClients()
  }, [])

  const sortedClients = useMemo(() => {
    const dir = sortDirection === 'asc' ? 1 : -1
    const safe = (v: string | null | undefined) => (v || '').toLowerCase()

    return [...clients].sort((a, b) => {
      if (sortKey === 'name') return dir * safe(a.name).localeCompare(safe(b.name))
      if (sortKey === 'primaryContact') return dir * safe(a.primaryContact).localeCompare(safe(b.primaryContact))
      return dir * safe(a.primaryEmail).localeCompare(safe(b.primaryEmail))
    })
  }, [clients, sortDirection, sortKey])

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
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <p className="text-muted-foreground">Loading clients...</p>
      </div>
    )
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <Building2 className="w-7 h-7 sm:w-8 sm:h-8" />
            Clients
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Manage client details, recipients, and files.
          </p>
        </div>
      </div>

        {error && (
          <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Clients</CardTitle>
          <Button variant="default" size="default" onClick={() => router.push('/admin/clients/new')}>
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Add New Client</span>
          </Button>
        </CardHeader>
        <CardContent>
          {sortedClients.length === 0 ? (
            <div className="text-sm text-muted-foreground py-10 text-center">
              No clients yet.
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

                        <th scope="col" className="px-3 py-2 text-center text-xs font-medium text-muted-foreground w-[96px]">
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

                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-[124px] sm:w-[140px]">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedClients.map((client) => (
                        <tr key={client.id} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-3 font-medium truncate">
                            {client.name}
                          </td>
                          <td className="px-3 py-3 text-center text-muted-foreground">
                            {Number.isFinite(client.contacts) ? client.contacts : 0}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground hidden md:table-cell truncate">
                            {client.primaryContact || '—'}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground hidden md:table-cell truncate">
                            {client.primaryEmail || '—'}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-3 w-full">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-10 px-0 sm:w-auto sm:px-3"
                                aria-label="Edit client"
                                title="Edit"
                                onClick={() => router.push(`/admin/clients/${client.id}`)}
                              >
                                <Edit className="w-4 h-4 sm:mr-2" />
                                <span className="hidden sm:inline">Edit</span>
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                className="w-10 px-0 sm:w-auto sm:px-3"
                                aria-label="Delete client"
                                title="Delete"
                                onClick={() => void handleDelete(client.id, client.name)}
                              >
                                <Trash2 className="w-4 h-4 sm:mr-2" />
                                <span className="hidden sm:inline">Delete</span>
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
