import { apiFetch } from '@/lib/api-client'
import type { SalesInvoice, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'
import {
  getSalesSeqState,
  getSalesSettings,
  listInvoices,
  listPayments,
  listQuotes,
  saveSalesSettings,
  setSalesSeqState,
  upsertInvoice,
  upsertPayment,
  upsertQuote,
} from '@/lib/sales/local-store'

export type SalesNativeStoreData = {
  quotes: SalesQuote[]
  invoices: SalesInvoice[]
  payments: SalesPayment[]
  settings: SalesSettings
  seq: { quote: number; invoice: number }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

export function snapshotSalesNativeStore(): SalesNativeStoreData {
  const settings = getSalesSettings()
  const seq = getSalesSeqState()

  return {
    quotes: listQuotes(),
    invoices: listInvoices(),
    payments: listPayments(),
    settings,
    seq,
  }
}

export async function pushSalesNativeStoreToServer(data?: SalesNativeStoreData): Promise<{ ok: boolean; updatedAt?: string }>
{
  const payload = data ?? snapshotSalesNativeStore()

  const res = await apiFetch('/api/admin/sales/native-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: payload }),
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const message = typeof json?.error === 'string' ? json.error : 'Unable to sync Sales data'
    throw new Error(message)
  }

  return { ok: true, updatedAt: typeof json?.updatedAt === 'string' ? json.updatedAt : undefined }
}

export async function pullSalesNativeStoreFromServer(): Promise<{ data: SalesNativeStoreData | null; updatedAt?: string }> {
  const res = await apiFetch('/api/admin/sales/native-store', { method: 'GET' })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const message = typeof json?.error === 'string' ? json.error : 'Unable to load Sales data'
    throw new Error(message)
  }

  const data = json?.data
  if (!data) return { data: null }

  const seqObj = asObject((data as any)?.seq)

  const normalized: SalesNativeStoreData = {
    quotes: asArray<SalesQuote>((data as any)?.quotes),
    invoices: asArray<SalesInvoice>((data as any)?.invoices),
    payments: asArray<SalesPayment>((data as any)?.payments),
    settings: asObject((data as any)?.settings) as SalesSettings,
    seq: {
      quote: Number.isFinite(Number(seqObj.quote)) ? Math.max(0, Math.trunc(Number(seqObj.quote))) : 0,
      invoice: Number.isFinite(Number(seqObj.invoice)) ? Math.max(0, Math.trunc(Number(seqObj.invoice))) : 0,
    },
  }

  return { data: normalized, updatedAt: typeof json?.updatedAt === 'string' ? json.updatedAt : undefined }
}

export function hydrateSalesNativeStoreFromSnapshot(snapshot: SalesNativeStoreData): void {
  for (const q of snapshot.quotes) {
    if (q && typeof (q as any).id === 'string') upsertQuote(q)
  }

  for (const inv of snapshot.invoices) {
    if (inv && typeof (inv as any).id === 'string') upsertInvoice(inv)
  }

  for (const p of snapshot.payments) {
    if (p && typeof (p as any).id === 'string') upsertPayment(p)
  }

  if (snapshot.settings) {
    saveSalesSettings(snapshot.settings as any)
  }

  // Avoid lowering counters if local is ahead.
  const current = getSalesSeqState()
  setSalesSeqState({
    quote: Math.max(current.quote ?? 0, snapshot.seq?.quote ?? 0),
    invoice: Math.max(current.invoice ?? 0, snapshot.seq?.invoice ?? 0),
  })
}

export async function pullAndHydrateSalesNativeStore(): Promise<{ hydrated: boolean; updatedAt?: string }> {
  const { data, updatedAt } = await pullSalesNativeStoreFromServer()
  if (!data) return { hydrated: false }

  hydrateSalesNativeStoreFromSnapshot(data)
  return { hydrated: true, updatedAt }
}
