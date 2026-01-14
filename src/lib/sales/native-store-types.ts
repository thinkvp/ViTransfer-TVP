import type { SalesInvoice, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'

export type SalesNativeStoreData = {
  quotes: SalesQuote[]
  invoices: SalesInvoice[]
  payments: SalesPayment[]
  settings: SalesSettings
  seq: { quote: number; invoice: number }
}
