import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import type { SalesInvoice, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'

export type SalesQuoteWithVersion = SalesQuote & { version: number }
export type SalesInvoiceWithVersion = SalesInvoice & { version: number }

export async function fetchSalesSettings(): Promise<SalesSettings> {
  return apiJson<SalesSettings>('/api/admin/sales/settings', { cache: 'no-store' })
}

export async function saveSalesSettings(settings: SalesSettings): Promise<SalesSettings> {
  const res = await apiPost<{ ok: boolean; settings: SalesSettings }>('/api/admin/sales/settings', settings)
  return res.settings
}

export async function listSalesQuotes(input?: { projectId?: string; clientId?: string; limit?: number }): Promise<SalesQuoteWithVersion[]> {
  const params = new URLSearchParams()
  if (input?.projectId) params.set('projectId', input.projectId)
  if (input?.clientId) params.set('clientId', input.clientId)
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit))
  const qs = params.toString()
  const res = await apiJson<{ quotes: SalesQuoteWithVersion[] }>(`/api/admin/sales/quotes${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
  return Array.isArray(res.quotes) ? res.quotes : []
}

export async function fetchSalesQuote(id: string): Promise<SalesQuoteWithVersion> {
  const res = await apiJson<{ quote: SalesQuoteWithVersion }>(`/api/admin/sales/quotes/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  })
  return res.quote
}

export async function createSalesQuote(payload: {
  clientId: string
  projectId?: string | null
  issueDate: string
  validUntil?: string | null
  notes?: string | null
  terms?: string | null
  items: any[]
}): Promise<SalesQuoteWithVersion> {
  const res = await apiPost<{ ok: boolean; quote: SalesQuoteWithVersion }>('/api/admin/sales/quotes', payload)
  return res.quote
}

export async function patchSalesQuote(id: string, patch: Partial<SalesQuote> & { version: number; items?: any[] }): Promise<SalesQuoteWithVersion> {
  const res = await apiPatch<{ ok: boolean; quote: SalesQuoteWithVersion }>(`/api/admin/sales/quotes/${encodeURIComponent(id)}`, patch)
  return res.quote
}

export async function deleteSalesQuote(id: string): Promise<void> {
  await apiDelete(`/api/admin/sales/quotes/${encodeURIComponent(id)}`)
}

export async function listSalesInvoices(input?: { projectId?: string; clientId?: string; limit?: number }): Promise<SalesInvoiceWithVersion[]> {
  const params = new URLSearchParams()
  if (input?.projectId) params.set('projectId', input.projectId)
  if (input?.clientId) params.set('clientId', input.clientId)
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit))
  const qs = params.toString()
  const res = await apiJson<{ invoices: SalesInvoiceWithVersion[] }>(`/api/admin/sales/invoices${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
  return Array.isArray(res.invoices) ? res.invoices : []
}

export async function fetchSalesInvoice(id: string): Promise<SalesInvoiceWithVersion> {
  const res = await apiJson<{ invoice: SalesInvoiceWithVersion }>(
    `/api/admin/sales/invoices/${encodeURIComponent(id)}`,
    { cache: 'no-store' }
  )
  return res.invoice
}

export async function createSalesInvoice(payload: {
  clientId: string
  projectId?: string | null
  issueDate: string
  dueDate?: string | null
  notes?: string | null
  terms?: string | null
  items: any[]
}): Promise<SalesInvoiceWithVersion> {
  const res = await apiPost<{ ok: boolean; invoice: SalesInvoiceWithVersion }>('/api/admin/sales/invoices', payload)
  return res.invoice
}

export async function patchSalesInvoice(id: string, patch: Partial<SalesInvoice> & { version: number; items?: any[] }): Promise<SalesInvoiceWithVersion> {
  const res = await apiPatch<{ ok: boolean; invoice: SalesInvoiceWithVersion }>(`/api/admin/sales/invoices/${encodeURIComponent(id)}`, patch)
  return res.invoice
}

export async function deleteSalesInvoice(id: string): Promise<void> {
  await apiDelete(`/api/admin/sales/invoices/${encodeURIComponent(id)}`)
}

export async function listSalesPayments(input?: { invoiceId?: string; clientId?: string; limit?: number }): Promise<SalesPayment[]> {
  const params = new URLSearchParams()
  if (input?.invoiceId) params.set('invoiceId', input.invoiceId)
  if (input?.clientId) params.set('clientId', input.clientId)
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit))
  const qs = params.toString()
  const res = await apiJson<{ payments: SalesPayment[] }>(`/api/admin/sales/payments${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
  return Array.isArray(res.payments) ? res.payments : []
}

export async function createSalesPayment(payload: {
  paymentDate: string
  amountCents: number
  method: string
  reference: string
  clientId?: string | null
  invoiceId?: string | null
}): Promise<SalesPayment> {
  const res = await apiPost<{ ok: boolean; payment: SalesPayment }>('/api/admin/sales/payments', payload)
  return res.payment
}

export async function deleteSalesPayment(id: string): Promise<void> {
  await apiDelete(`/api/admin/sales/payments/${encodeURIComponent(id)}`)
}
