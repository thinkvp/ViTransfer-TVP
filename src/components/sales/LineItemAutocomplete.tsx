'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import type { SalesItem } from '@/lib/sales/admin-api'

type Props = {
  value: string
  onChange: (value: string) => void
  onSelectItem: (item: SalesItem) => void
  /** Called after an item is selected. Use this to add a new line and focus it. */
  onAfterSelect?: () => void
  libraryItems: SalesItem[]
  placeholder?: string
  className?: string
  /** Attach this ref to the underlying <input> to allow external focus control. */
  inputRef?: React.RefCallback<HTMLInputElement> | React.RefObject<HTMLInputElement>
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function LineItemAutocomplete({
  value,
  onChange,
  onSelectItem,
  onAfterSelect,
  libraryItems,
  placeholder,
  className,
  inputRef,
}: Props) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return []
    return libraryItems
      .filter((item) => item.description.toLowerCase().includes(q))
      .slice(0, 10)
  }, [value, libraryItems])

  // Reset active index whenever the filtered list changes
  useEffect(() => {
    setActiveIndex(-1)
  }, [filtered])

  // Scroll the active item into view
  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return
    const btn = listRef.current.querySelectorAll<HTMLButtonElement>('button')[activeIndex]
    btn?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function commit(item: SalesItem) {
    onSelectItem(item)
    setOpen(false)
    setActiveIndex(-1)
    onAfterSelect?.()
  }

  return (
    <div ref={rootRef} className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (!open || filtered.length === 0) {
            if (e.key === 'Escape') setOpen(false)
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            if (activeIndex >= 0 && activeIndex < filtered.length) {
              e.preventDefault()
              commit(filtered[activeIndex])
            }
          } else if (e.key === 'Escape') {
            setOpen(false)
            setActiveIndex(-1)
          }
        }}
        placeholder={placeholder}
        className={className ?? 'h-9'}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          <div ref={listRef} className="max-h-64 overflow-auto py-1">
            {filtered.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`w-full text-left px-3 py-2 text-sm${
                  idx === activeIndex
                    ? ' bg-accent text-accent-foreground'
                    : ' hover:bg-accent hover:text-accent-foreground'
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => commit(item)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium truncate">{item.description}</span>
                  <span className="shrink-0 text-xs opacity-70">
                    {item.quantity} × {fmtCents(item.unitPriceCents)}
                  </span>
                </div>
                {item.details ? (
                  <div className="text-xs opacity-70 truncate">{item.details}</div>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
