'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LabelOption {
  id: string
  name: string
  color?: string | null
  isActive: boolean
}

interface SearchableLabelSelectProps {
  value: string | null
  labels: LabelOption[]
  onChange: (labelId: string | null, label: LabelOption | null) => void
  triggerClassName?: string
  placeholder?: string
}

export function SearchableLabelSelect({
  value,
  labels,
  onChange,
  triggerClassName,
  placeholder = 'No label',
}: SearchableLabelSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeLabels = labels.filter((l) => l.isActive)
  const filtered = search
    ? activeLabels.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : activeLabels

  const selected = value ? activeLabels.find((l) => l.id === value) : null

  useEffect(() => {
    if (open) {
      setSearch('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-8 w-full items-center justify-between rounded-lg border border-input bg-background px-2 py-1 text-xs ring-offset-background transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          triggerClassName,
        )}
      >
        <span className="truncate">
          {selected ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: selected.color ?? '#6366F1' }}
              />
              {selected.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 opacity-50 flex-shrink-0 ml-1" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[160px] rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-elevation-lg overflow-hidden">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/40">
            <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search labels…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                if (e.key === 'Enter' && filtered.length === 1) {
                  onChange(filtered[0].id, filtered[0])
                  setOpen(false)
                }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            <button
              type="button"
              className={cn(
                'flex w-full items-center rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors',
                !value && 'bg-accent/50',
              )}
              onClick={() => {
                onChange(null, null)
                setOpen(false)
              }}
            >
              No label
            </button>
            {filtered.map((l) => (
              <button
                key={l.id}
                type="button"
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors',
                  value === l.id && 'bg-accent/50',
                )}
                onClick={() => {
                  onChange(l.id, l)
                  setOpen(false)
                }}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: l.color ?? '#6366F1' }}
                />
                {l.name}
              </button>
            ))}
            {search && filtered.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground text-center">No labels found</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
