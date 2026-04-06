'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'

interface ExportMenuProps {
  onExportCsv: () => void
  onExportPdf: () => void
  disabled?: boolean
}

export function ExportMenu({ onExportCsv, onExportPdf, disabled }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen(o => !o)} disabled={disabled} className="gap-1.5">
        <Download className="w-3.5 h-3.5" />Export
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1">
          <button type="button" onClick={() => { onExportCsv(); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors">
            Export CSV
          </button>
          <button type="button" onClick={() => { onExportPdf(); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors">
            Export PDF
          </button>
        </div>
      )}
    </div>
  )
}

// Utility: download a CSV blob
export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`
    return val
  }
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Utility: download the current view as a PDF via print
export function downloadPdf(title: string) {
  const style = document.createElement('style')
  style.textContent = `
    @media print {
      nav, header, [data-no-print], button, .no-print { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `
  document.head.appendChild(style)
  document.title = title
  window.print()
  document.head.removeChild(style)
}
