import { prisma } from '@/lib/db'
import type { AccountingSettings } from '@/lib/accounting/types'

function defaultAccountingSettingsRow() {
  return {
    id: 'default',
    reportingBasis: 'ACCRUAL' as const,
    basGstAccountId: null as string | null,
    basPaygAccountId: null as string | null,
    basPaygInstalmentDefaultCents: null as number | null,
  }
}

export function accountingSettingsFromDb(row: any): AccountingSettings {
  return {
    reportingBasis: row?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL',
    basGstAccountId: row?.basGstAccountId ?? null,
    basPaygAccountId: row?.basPaygAccountId ?? null,
    basPaygInstalmentDefaultCents: row?.basPaygInstalmentDefaultCents != null ? Number(row.basPaygInstalmentDefaultCents) : null,
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

export async function saveAccountingSettings(input: {
  reportingBasis: 'CASH' | 'ACCRUAL'
  basGstAccountId?: string | null
  basPaygAccountId?: string | null
  basPaygInstalmentDefaultCents?: number | null
}): Promise<AccountingSettings> {
  const row = await prisma.accountingSettings.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      reportingBasis: input.reportingBasis,
      basGstAccountId: input.basGstAccountId ?? null,
      basPaygAccountId: input.basPaygAccountId ?? null,
      basPaygInstalmentDefaultCents: input.basPaygInstalmentDefaultCents ?? null,
    },
    update: {
      reportingBasis: input.reportingBasis,
      basGstAccountId: input.basGstAccountId ?? null,
      basPaygAccountId: input.basPaygAccountId ?? null,
      basPaygInstalmentDefaultCents: input.basPaygInstalmentDefaultCents ?? null,
    },
  })

  return accountingSettingsFromDb(row)
}