'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type DatePreset = 'THIS_FY' | 'FYTD' | 'LAST_FY' | 'YTD' | 'LAST_12M' | 'LAST_30D' | 'ALL_TIME' | 'CUSTOM'

const PRESET_ORDER: DatePreset[] = ['THIS_FY', 'FYTD', 'LAST_FY', 'YTD', 'LAST_12M', 'LAST_30D', 'ALL_TIME']

export function getThisFinancialYearDates(now = new Date()): { from: string; to: string } {
  const month = now.getMonth()
  const year = now.getFullYear()
  const financialYearStart = month >= 6 ? year : year - 1
  return { from: `${financialYearStart}-07-01`, to: `${financialYearStart + 1}-06-30` }
}

function getPresetDates(p: DatePreset): { from: string; to: string } | null {
  if (p === 'CUSTOM') return null
  if (p === 'ALL_TIME') return { from: '', to: '' }
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const m = now.getMonth() // 0-11
  const y = now.getFullYear()
  const fyYear = m >= 6 ? y : y - 1 // AU FY start year (Jul–Jun)
  if (p === 'THIS_FY') return getThisFinancialYearDates(now)
  if (p === 'FYTD') return { from: `${fyYear}-07-01`, to: today }
  if (p === 'LAST_FY') return { from: `${fyYear - 1}-07-01`, to: `${fyYear}-06-30` }
  if (p === 'YTD') return { from: `${y}-01-01`, to: today }
  if (p === 'LAST_12M') {
    const d = new Date(now)
    d.setFullYear(d.getFullYear() - 1)
    return { from: d.toISOString().slice(0, 10), to: today }
  }
  if (p === 'LAST_30D') {
    const d = new Date(now)
    d.setDate(d.getDate() - 30)
    return { from: d.toISOString().slice(0, 10), to: today }
  }
  return null
}

function inferPreset(from: string, to: string): DatePreset {
  if (!from && !to) return 'ALL_TIME'

  for (const preset of PRESET_ORDER) {
    const dates = getPresetDates(preset)
    if (dates && dates.from === from && dates.to === to) return preset
  }

  return 'CUSTOM'
}

interface DateRangePresetProps {
  from: string
  to: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
}

export function DateRangePreset({ from, to, onFromChange, onToChange }: DateRangePresetProps) {
  const [preset, setPreset] = useState<DatePreset>(() => inferPreset(from, to))

  useEffect(() => {
    setPreset(inferPreset(from, to))
  }, [from, to])

  function handlePresetChange(p: DatePreset) {
    setPreset(p)
    if (p !== 'CUSTOM') {
      const dates = getPresetDates(p)!
      onFromChange(dates.from)
      onToChange(dates.to)
    }
  }

  function handleFromChange(v: string) {
    setPreset('CUSTOM')
    onFromChange(v)
  }

  function handleToChange(v: string) {
    setPreset('CUSTOM')
    onToChange(v)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        type="date"
        value={from}
        onChange={e => handleFromChange(e.target.value)}
        className="h-9 w-36"
        title="Start date"
      />
      <span className="text-muted-foreground text-sm leading-none select-none">→</span>
      <Input
        type="date"
        value={to}
        onChange={e => handleToChange(e.target.value)}
        className="h-9 w-36"
        title="End date"
      />
      <Select value={preset} onValueChange={v => handlePresetChange(v as DatePreset)}>
        <SelectTrigger className="h-9 w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="THIS_FY">This financial year</SelectItem>
          <SelectItem value="FYTD">Financial year to date</SelectItem>
          <SelectItem value="LAST_FY">Last financial year</SelectItem>
          <SelectItem value="YTD">Year to date</SelectItem>
          <SelectItem value="LAST_12M">Last 12 months</SelectItem>
          <SelectItem value="LAST_30D">Last 30 days</SelectItem>
          <SelectItem value="ALL_TIME">All time</SelectItem>
          <SelectItem value="CUSTOM">Custom</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
