import { apiPost } from '@/lib/api-client'
import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'

export type SalesDocShareType = 'QUOTE' | 'INVOICE'

export async function createSalesDocShareUrl(input: {
  type: SalesDocShareType
  doc: SalesQuote | SalesInvoice
  settings: SalesSettings
  clientName?: string
  projectTitle?: string
  invoicePaidAt?: string | null
}): Promise<string> {
  const res = await apiPost<{ url?: string; path?: string }>(
    '/api/sales/share',
    {
      type: input.type,
      doc: input.doc,
      settings: input.settings,
      clientName: input.clientName ?? null,
      projectTitle: input.projectTitle ?? null,
      invoicePaidAt: input.invoicePaidAt ?? null,
    }
  )

  const url = res.url || res.path
  if (!url) throw new Error('Share link created but no URL returned')
  return url
}
