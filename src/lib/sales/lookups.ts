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

export async function fetchClientOptions(): Promise<ClientOption[]> {
  const res = await apiFetch('/api/clients?active=all')
  if (!res.ok) return []
  const data = await res.json()
  const list = Array.isArray(data?.clients) ? data.clients : []
  return list
    .map((c: any) => ({ id: String(c?.id || ''), name: String(c?.name || '') }))
    .filter((c: ClientOption) => c.id && c.name)
}

export async function fetchClientDetails(clientId: string): Promise<ClientDetails | null> {
  if (!clientId) return null
  const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}`)
  if (!res.ok) return null
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
  if (!res.ok) return []
  const data = await res.json()
  const list = Array.isArray(data?.projects) ? data.projects : []
  return list
    .map((p: any) => ({ id: String(p?.id || ''), title: String(p?.title || p?.slug || ''), _createdAt: p?.createdAt ?? '' }))
    .filter((p: any) => p.id && p.title)
    .sort((a: any, b: any) => (a._createdAt < b._createdAt ? 1 : a._createdAt > b._createdAt ? -1 : 0))
    .map(({ _createdAt, ...rest }: any) => rest as ProjectOption)
}

export async function fetchProjectOptionsForClient(clientId: string): Promise<ProjectOption[]> {
  if (!clientId) return []
  const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/projects`)
  if (!res.ok) return []
  const data = await res.json()
  const list = Array.isArray(data?.projects) ? data.projects : []
  return list
    .map((p: any) => ({ id: String(p?.id || ''), title: String(p?.title || p?.slug || ''), _createdAt: p?.createdAt ?? '' }))
    .filter((p: any) => p.id && p.title)
    .sort((a: any, b: any) => (a._createdAt < b._createdAt ? 1 : a._createdAt > b._createdAt ? -1 : 0))
    .map(({ _createdAt, ...rest }: any) => rest as ProjectOption)
}
