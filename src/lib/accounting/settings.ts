import { prisma } from '@/lib/db'
import type { AccountingSettings } from '@/lib/accounting/types'

function defaultAccountingSettingsRow() {
  return {
    id: 'default',
    reportingBasis: 'ACCRUAL' as const,
  }
}

export function accountingSettingsFromDb(row: any): AccountingSettings {
  return {
    reportingBasis: row?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL',
    updatedAt: row?.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row?.updatedAt ?? new Date(0).toISOString()),
  }
}

export async function getAccountingSettings(): Promise<AccountingSettings> {
  const row = await prisma.accountingSettings.upsert({
    where: { id: 'default' },
    create: defaultAccountingSettingsRow(),
    update: {},
  })

  return accountingSettingsFromDb(row)
}

export async function getAccountingReportingBasis(): Promise<'CASH' | 'ACCRUAL'> {
  const settings = await getAccountingSettings()
  return settings.reportingBasis
}

export async function saveAccountingSettings(input: { reportingBasis: 'CASH' | 'ACCRUAL' }): Promise<AccountingSettings> {
  const row = await prisma.accountingSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', reportingBasis: input.reportingBasis },
    update: { reportingBasis: input.reportingBasis },
  })

  return accountingSettingsFromDb(row)
}