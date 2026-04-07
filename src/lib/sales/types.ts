// NOTE: 'OPENED' is a derived/effective status (based on email open tracking),
// and is not persisted as a SalesQuoteStatus/SalesInvoiceStatus in Prisma.
export type QuoteStatus = 'OPEN' | 'SENT' | 'OPENED' | 'CLOSED' | 'ACCEPTED'
export type InvoiceStatus = 'OPEN' | 'SENT' | 'OPENED' | 'OVERDUE' | 'PARTIALLY_PAID' | 'PAID'

export type MoneyCents = number

export type SalesLineItem = {
  id: string
  /**
   * Line item name / QuickBooks item name.
   * (Displayed as the main bold line on PDFs.)
   */
  description: string
  /** Optional paragraph description shown under the item on PDFs. */
  details?: string
  quantity: number
  unitPriceCents: MoneyCents
  taxRatePercent: number
  /** Display name of the tax rate, e.g. "GST". Stored per-item for historical accuracy. */
  taxRateName?: string
  /** ID of the SalesLabel applied to this line item (internal use only; not shown on public docs). */
  labelId?: string | null
  /** Denormalised label name snapshot (preserved if label is later renamed/deleted). */
  labelName?: string | null
  /** Denormalised label color snapshot e.g. "#3B82F6". */
  labelColor?: string | null
}

export type SalesQuote = {
  id: string
  quoteNumber: string
  status: QuoteStatus
  acceptedFromStatus?: QuoteStatus | null
  clientId: string | null
  projectId: string | null
  issueDate: string // YYYY-MM-DD
  validUntil: string | null // YYYY-MM-DD
  /** Enable/disable automated reminders for this document (default: enabled). */
  remindersEnabled?: boolean
  /** YYYY-MM-DD when the last expiry reminder was sent (prevents daily duplicates). */
  lastExpiryReminderSentYmd?: string | null
  /** Whether tax was enabled at the time this document was created. */
  taxEnabled: boolean
  notes: string
  terms: string
  items: SalesLineItem[]
  createdAt: string
  updatedAt: string
  sentAt: string | null
  /** True when at least one tracked email for this doc has been opened. (Derived; not stored on the doc.) */
  hasOpenedEmail?: boolean
}

export type SalesInvoice = {
  id: string
  invoiceNumber: string
  status: InvoiceStatus
  clientId: string | null
  projectId: string | null
  issueDate: string // YYYY-MM-DD
  dueDate: string | null // YYYY-MM-DD
  /** Enable/disable automated reminders for this document (default: enabled). */
  remindersEnabled?: boolean
  /** YYYY-MM-DD when the last overdue reminder was sent (prevents daily duplicates). */
  lastOverdueReminderSentYmd?: string | null
  /** Whether tax was enabled at the time this document was created. */
  taxEnabled: boolean
  notes: string
  terms: string
  items: SalesLineItem[]
  createdAt: string
  updatedAt: string
  sentAt: string | null
  /** True when at least one tracked email for this doc has been opened. (Derived; not stored on the doc.) */
  hasOpenedEmail?: boolean
}

export type SalesPayment = {
  id: string
  paymentDate: string // YYYY-MM-DD
  amountCents: MoneyCents
  method: string
  reference: string
  clientId: string | null
  invoiceId: string | null
  excludeFromInvoiceBalance?: boolean
  createdAt: string
}

export type SalesSettings = {
  businessName: string
  address: string
  abn: string
  phone: string
  email: string
  website: string
  businessRegistrationLabel: string
  currencyCode: string
  fiscalYearStartMonth: number
  quoteLabel: string
  invoiceLabel: string
  taxLabel: string
  taxEnabled: boolean
  dashboardReportingBasis?: 'CASH' | 'ACCRUAL'
  dashboardAmountsIncludeGst?: boolean
  taxRatePercent: number
  defaultQuoteValidDays: number
  defaultInvoiceDueDays: number
  defaultTerms: string
  paymentDetails: string
  defaultIncomeAccountId?: string | null
  updatedAt: string
}

export type SalesTaxRate = {
  id: string
  name: string
  rate: number
  isDefault: boolean
  sortOrder: number
}

export type ClientOption = { id: string; name: string }
export type ProjectOption = { id: string; title: string }
