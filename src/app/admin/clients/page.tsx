'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Building2, Plus, Pencil, Trash2, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface ClientRow {
  id: string
  name: string
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
      <div className="max-w-4xl mx-auto">
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="default" onClick={() => void loadClients()}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button variant="default" size="default" onClick={() => router.push('/admin/clients/new')}>
              <Plus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Add New Client</span>
            </Button>
          </div>
        </div>

        {error && (
          <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Clients</CardTitle>
          </CardHeader>
          <CardContent>
            {sortedClients.length === 0 ? (
              <div className="text-sm text-muted-foreground py-10 text-center">
                No clients yet.
              </div>
            ) : (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                <div className="w-full overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr className="border-b border-border">
                        {(
                          [
                            { key: 'name', label: 'Client Name', className: 'min-w-[220px]' },
                            { key: 'primaryContact', label: 'Primary Contact', className: 'min-w-[200px]' },
                            { key: 'primaryEmail', label: 'Primary Email', className: 'min-w-[240px]' },
                          ] as const
                        ).map((col) => (
                          <th
                            key={col.key}
                            scope="col"
                            className={cn('px-3 py-2 text-left text-xs font-medium text-muted-foreground', col.className)}
                          >
                            <button
                              type="button"
                              onClick={() => toggleSort(col.key)}
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              title="Sort"
                            >
                              <span>{col.label}</span>
                              {sortKey === col.key &&
                                (sortDirection === 'asc' ? (
                                  <ArrowUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ArrowDown className="h-3.5 w-3.5" />
                                ))}
                            </button>
                          </th>
                        ))}
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-[140px]">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedClients.map((client) => (
                        <tr key={client.id} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-3 font-medium">
                            {client.name}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">
                            {client.primaryContact || '—'}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">
                            {client.primaryEmail || '—'}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => router.push(`/admin/clients/${client.id}`)}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleDelete(client.id, client.name)}
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
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
