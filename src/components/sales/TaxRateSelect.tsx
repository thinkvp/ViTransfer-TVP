'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SalesTaxRate } from '@/lib/sales/types'

interface TaxRateSelectProps {
  value: number
  onChange: (rate: number, name?: string) => void
  taxRates: SalesTaxRate[]
  className?: string
}

export function TaxRateSelect({ value, onChange, taxRates, className }: TaxRateSelectProps) {
  // Ensure there's always a 0% entry and avoid duplicates
  const hasZeroRate = taxRates.some((r) => r.rate === 0)

  return (
    <Select
      value={String(value)}
      onValueChange={(v) => {
        const rate = Number(v)
        if (Number.isFinite(rate) && rate >= 0) {
          const matched = taxRates.find((r) => r.rate === rate)
          onChange(rate, matched?.name)
        }
      }}
    >
      <SelectTrigger className={className || 'h-9'} tabIndex={-1}>
        <SelectValue placeholder="Tax" />
      </SelectTrigger>
      <SelectContent>
        {!hasZeroRate && (
          <SelectItem value="0">No Tax (0%)</SelectItem>
        )}
        {taxRates.map((r) => (
          <SelectItem key={r.id} value={String(r.rate)}>
            {r.name} ({r.rate}%)
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
