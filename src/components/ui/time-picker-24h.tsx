'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function isValidTime24h(value: string): boolean {
  return Boolean(/^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(value))
}

function splitTime(value: string): { hh: string; mm: string } {
  if (!isValidTime24h(value)) return { hh: '12', mm: '00' }
  const [hh, mm] = value.split(':')
  return { hh, mm }
}

export function TimePicker24h({
  value,
  onChange,
  disabled,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'hour' | 'minute'>('hour')
  const [draftTime, setDraftTime] = useState('12:00')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const hourOptions = useMemo(() => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), [])
  const minuteOptions = useMemo(() => Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')), [])

  const openPicker = () => {
    if (disabled) return

    const trimmed = value.trim()
    const next = isValidTime24h(trimmed) ? trimmed : '12:00'
    setDraftTime(next)
    if (!trimmed) onChange('12:00')
    setStep('hour')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return

    const onDocPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('touchstart', onDocPointer)

    return () => {
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('touchstart', onDocPointer)
    }
  }, [open])

  const current = isValidTime24h(draftTime) ? draftTime : '12:00'
  const { hh, mm } = splitTime(current)

  return (
    <div ref={rootRef} className="relative">
      <Input
        type="text"
        value={value}
        readOnly
        disabled={disabled}
        placeholder={placeholder || 'HH:MM'}
        onClick={openPicker}
        onFocus={() => {
          if (open) return
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            openPicker()
            e.preventDefault()
            return
          }
          if (e.key === 'Escape') {
            setOpen(false)
            return
          }
          if (e.key === 'Backspace' || e.key === 'Delete') {
            onChange('')
            e.preventDefault()
            return
          }
          if (e.key === 'Tab' || e.key.startsWith('Arrow')) return
          if (e.key.length === 1) e.preventDefault()
        }}
        className={className}
      />

      {open ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md p-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={step === 'hour' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStep('hour')}
              className="h-8"
            >
              HH: {hh}
            </Button>
            <Button
              type="button"
              variant={step === 'minute' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStep('minute')}
              className="h-8"
            >
              MM: {mm}
            </Button>
          </div>

          {step === 'hour' ? (
            <div className="grid grid-cols-6 gap-1 max-h-40 overflow-y-auto pr-0.5">
              {hourOptions.map((hour) => (
                <Button
                  key={hour}
                  type="button"
                  variant={hour === hh ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    const next = `${hour}:${mm}`
                    setDraftTime(next)
                    onChange(next)
                    setStep('minute')
                  }}
                  className="h-8 px-0"
                >
                  {hour}
                </Button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1">
              {minuteOptions.map((minute) => (
                <Button
                  key={minute}
                  type="button"
                  variant={minute === mm ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    const next = `${hh}:${minute}`
                    setDraftTime(next)
                    onChange(next)
                    setOpen(false)
                    setStep('hour')
                  }}
                  className="h-8 px-0"
                >
                  {minute}
                </Button>
              ))}
            </div>
          )}

          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange('')
                setDraftTime('12:00')
                setStep('hour')
              }}
            >
              Clear
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
