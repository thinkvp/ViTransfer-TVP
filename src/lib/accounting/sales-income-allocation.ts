import { prisma } from '@/lib/db'
import { calcLineSubtotalCents } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'

const SALES_INVOICE_ACCOUNTING_STATUSES = ['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'] as const

type IncomeAccountRef = {
  id: string
  code: string
  name: string
}

type LabelAccountRef = {
  id: string
  name: string
  accountId: string | null
  account: { code: string; name: string } | null
}

export type SalesIncomeAccountContext = {
  defaultIncomeAccount: IncomeAccountRef
  labelAccountMap: Map<string, LabelAccountRef>
}

export type SalesIncomeAllocation = {
  allocationId: string
  accountId: string
  accountCode: string
  accountName: string
  amountCents: number
  itemId: string
  itemDescription: string
  labelId: string | null
  labelName: string | null
}

export type SalesInvoiceIncomeEntry = SalesIncomeAllocation & {
  invoiceId: string
  invoiceNumber: string
  issueDate: string
  clientName: string | null
}

export async function getSalesIncomeAccountContext(): Promise<SalesIncomeAccountContext> {
  const [settings, labels] = await Promise.all([
    prisma.salesSettings.findUnique({
      where: { id: 'default' },
      include: { defaultIncomeAccount: { select: { id: true, code: true, name: true } } },
    }),
    prisma.salesLabel.findMany({
      select: {
        id: true,
        name: true,
        accountId: true,
        account: { select: { code: true, name: true } },
      },
    }),
  ])

  return {
    defaultIncomeAccount: settings?.defaultIncomeAccount
      ? {
          id: settings.defaultIncomeAccount.id,
          code: settings.defaultIncomeAccount.code,
          name: settings.defaultIncomeAccount.name,
        }
      : {
          id: '__unmapped_sales_income__',
          code: '',
          name: 'Unmapped Sales Income',
        },
    labelAccountMap: new Map(labels.map((label) => [label.id, label])),
  }
}

export function allocateSalesLineItemsToIncomeAccounts(
  items: SalesLineItem[],
  context: SalesIncomeAccountContext
): SalesIncomeAllocation[] {
  return items.flatMap((item, index) => {
    const amountCents = calcLineSubtotalCents(item)
    if (amountCents === 0) return []

    const linkedLabel = item.labelId ? context.labelAccountMap.get(item.labelId) ?? null : null
    const account = linkedLabel?.accountId && linkedLabel.account
      ? {
          id: linkedLabel.accountId,
          code: linkedLabel.account.code,
          name: linkedLabel.account.name,
        }
      : context.defaultIncomeAccount

    return [{
      allocationId: `${item.id || `line-${index}`}:${account.id}`,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      amountCents,
      itemId: item.id || `line-${index}`,
      itemDescription: item.description || 'Sales line item',
      labelId: item.labelId ?? null,
      labelName: linkedLabel?.name ?? item.labelName ?? null,
    }]
  })
}

export async function listSalesInvoiceIncomeEntries(input?: {
  from?: string
  to?: string
  accountId?: string
  accountIds?: string[]
}): Promise<SalesInvoiceIncomeEntry[]> {
  const context = await getSalesIncomeAccountContext()
  const issueDateFilter: { gte?: string; lte?: string } = {}
  if (input?.from) issueDateFilter.gte = input.from
  if (input?.to) issueDateFilter.lte = input.to

  const invoices = await prisma.salesInvoice.findMany({
    where: {
      status: { in: [...SALES_INVOICE_ACCOUNTING_STATUSES] },
      ...(Object.keys(issueDateFilter).length ? { issueDate: issueDateFilter } : {}),
    },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      itemsJson: true,
      client: { select: { name: true } },
    },
    orderBy: [{ issueDate: 'desc' }, { invoiceNumber: 'desc' }],
  })

  // Build the applicable account ID set (accountIds takes precedence over accountId)
  const filterIds: string[] | null = input?.accountIds?.length
    ? input.accountIds
    : input?.accountId
    ? [input.accountId]
    : null

  return invoices.flatMap((invoice) => {
    const items = Array.isArray(invoice.itemsJson) ? (invoice.itemsJson as SalesLineItem[]) : []
    return allocateSalesLineItemsToIncomeAccounts(items, context)
      .filter((allocation) => !filterIds || filterIds.includes(allocation.accountId))
      .map((allocation) => ({
        ...allocation,
        allocationId: `${invoice.id}:${allocation.allocationId}`,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        clientName: invoice.client?.name ?? null,
      }))
  })
}