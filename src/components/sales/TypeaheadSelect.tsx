'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

export type TypeaheadOption = {
  value: string
  label: string
}

type Props = {
  label?: string
  value: string
  onValueChange: (value: string) => void
  options: TypeaheadOption[]
  placeholder?: string
  disabled?: boolean
  allowNone?: boolean
  noneLabel?: string
  emptyText?: string
}

export function TypeaheadSelect({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  allowNone = false,
  noneLabel = '(none)',
  emptyText = 'No matches',
}: Props) {
  const selectedLabel = useMemo(() => options.find((o) => o.value === value)?.label ?? '', [options, value])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setQuery(selectedLabel)
  }, [selectedLabel])

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
      setQuery(selectedLabel)
    }

    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [selectedLabel])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  return (
    <div ref={rootRef} className="relative">
      <Input
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        className="h-9"
        onFocus={() => {
          if (disabled) return
          setOpen(true)
        }}
        onChange={(e) => {
          if (disabled) return
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            setQuery(selectedLabel)
          }
        }}
      />

      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          <div className="max-h-64 overflow-auto py-1">
            {allowNone && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onValueChange('')
                  setOpen(false)
                  setQuery('')
                }}
              >
                {noneLabel}
              </button>
            )}

            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground ${
                    o.value === value ? 'bg-accent text-accent-foreground' : ''
                  }`}
                  onClick={() => {
                    onValueChange(o.value)
                    setOpen(false)
                    setQuery(o.label)
                  }}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
