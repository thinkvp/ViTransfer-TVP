import { apiFetch } from '@/lib/api-client'
import type { ClientOption, ProjectOption } from '@/lib/sales/types'

export type ClientDetails = {
  id: string
  name: string
  address: string | null
  recipients?: Array<{
    id: string
    name: string | null
    email: string | null
    isPrimary: boolean
  }>
}

/**
 * Minimal client/project directory, used as a fallback when the caller cannot
 * reach the Clients/Projects endpoints (a Sales/Accounting-only role, e.g. an
 * accountant). Without it those areas render raw ids instead of names.
 * Cached per page load — several call sites resolve names independently.
 */
let directoryPromise: Promise<{ clients: any[]; projects: any[] } | null> | null = null

function fetchDirectory(): Promise<{ clients: any[]; projects: any[] } | null> {
  if (!directoryPromise) {
    directoryPromise = apiFetch('/api/admin/lookups')
      .then(async (res) => {
        if (!res.ok) return null
        const data = await res.json()
        return {
          clients: Array.isArray(data?.clients) ? data.clients : [],
          projects: Array.isArray(data?.projects) ? data.projects : [],
        }
      })
      .catch(() => null)
  }
  return directoryPromise
}

function toProjectOptions(list: any[]): ProjectOption[] {
  return list
    .map((p: any) => ({ id: String(p?.id || ''), title: String(p?.title || p?.slug || ''), _sortDate: p?.startDate ?? p?.createdAt ?? '' }))
    .filter((p: any) => p.id && p.title)
    .sort((a: any, b: any) => (a._sortDate < b._sortDate ? 1 : a._sortDate > b._sortDate ? -1 : 0))
    .map(({ _sortDate, ...rest }: any) => rest as ProjectOption)
}

export async function fetchClientOptions(): Promise<ClientOption[]> {
  const res = await apiFetch('/api/clients?active=all')
  if (!res.ok) {
    const directory = await fetchDirectory()
    if (!directory) return []
    return directory.clients
      .map((c: any) => ({ id: String(c?.id || ''), name: String(c?.name || '') }))
      .filter((c: ClientOption) => c.id && c.name)
  }
  const data = await res.json()
  const list = Array.isArray(data?.clients) ? data.clients : []
  return list
    .map((c: any) => ({ id: String(c?.id || ''), name: String(c?.name || '') }))
    .filter((c: ClientOption) => c.id && c.name)
}

export async function fetchClientDetails(clientId: string): Promise<ClientDetails | null> {
  if (!clientId) return null
  const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}`)
  if (!res.ok) {
    // Fall back to the directory: name + address (what a document prints).
    // Recipients are intentionally unavailable here — they are only needed for
    // sending, which a read-only role cannot do anyway.
    const directory = await fetchDirectory()
    const entry = directory?.clients.find((c: any) => String(c?.id) === clientId)
    if (!entry) return null
    const name = String(entry.name || '')
    if (!name) return null
    const addressRaw = typeof entry.address === 'string' ? entry.address.trim() : ''
    return { id: clientId, name, address: addressRaw ? addressRaw : null, recipients: [] }
  }
  const data = await res.json()
  const c = data?.client
  const id = String(c?.id || '')
  const name = String(c?.name || '')
  const addressRaw = typeof c?.address === 'string' ? c.address.trim() : ''
  const address = addressRaw ? addressRaw : null

  const recipientsRaw = Array.isArray(c?.recipients) ? c.recipients : []
  const recipients = recipientsRaw
    .map((r: any) => ({
      id: String(r?.id || ''),
      name: typeof r?.name === 'string' ? r.name : null,
      email: typeof r?.email === 'string' ? r.email : null,
      isPrimary: Boolean(r?.isPrimary),
    }))
    .filter((r: any) => r.id)

  if (!id || !name) return null
  return { id, name, address, recipients }
}

export async function fetchProjectOptions(): Promise<ProjectOption[]> {
  const res = await apiFetch('/api/projects')
  if (!res.ok) {
    const directory = await fetchDirectory()
    return directory ? toProjectOptions(directory.projects) : []
  }
  const data = await res.json()
  const list = Array.isArray(data?.projects) ? data.projects : []
  return toProjectOptions(list)
}

export async function fetchProjectOptionsForClient(clientId: string): Promise<ProjectOption[]> {
  if (!clientId) return []
  const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/projects`)
  if (!res.ok) {
    const directory = await fetchDirectory()
    if (!directory) return []
    return toProjectOptions(directory.projects.filter((p: any) => String(p?.clientId || '') === clientId))
  }
  const data = await res.json()
  const list = Array.isArray(data?.projects) ? data.projects : []
  return toProjectOptions(list)
}
