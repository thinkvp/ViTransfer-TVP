'use client'

import { useState, useRef, useEffect } from 'react'
import { formatDate } from '@/lib/utils'
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

// ── PDF report types ──────────────────────────────────────────────────────────

export interface PdfColumn {
  header: string
  align?: 'left' | 'right' | 'center'
  /** If true the cell will never line-break (use for dates, amounts, codes) */
  nowrap?: boolean
}

export interface PdfRow {
  cells: string[]
  bold?: boolean
  /** Render a top-border above this row (for subtotals / totals) */
  separator?: boolean
  /** Thicker double-border (for grand totals) */
  doubleSeparator?: boolean
  /** Indent the first cell (for child account rows etc.) */
  indent?: boolean
  /** Optional cell-level colour override: 'green' | 'red' */
  color?: string
}

export interface PdfSection {
  title?: string
  columns?: PdfColumn[]
  rows: PdfRow[]
}

export interface PdfReportOptions {
  title: string
  subtitle?: string
  sections: PdfSection[]
}

/**
 * Inject a hidden iframe into the current page, write the report HTML into it,
 * and trigger a single print dialog — no popup window, no double-print.
 */
export function generateReportPdf({ title, subtitle, sections }: PdfReportOptions) {
  const html = buildReportHtml(title, subtitle, sections)

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:0;visibility:hidden;'
  document.body.appendChild(iframe)

  const iframeDoc = iframe.contentDocument ?? iframe.contentWindow?.document
  if (!iframeDoc) { document.body.removeChild(iframe); return }

  iframeDoc.open()
  iframeDoc.write(html)
  iframeDoc.close()

  iframe.onload = () => {
    iframe.contentWindow?.print()
    // Remove the iframe after the print dialog is dismissed
    setTimeout(() => { document.body.removeChild(iframe) }, 1000)
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildReportHtml(title: string, subtitle: string | undefined, sections: PdfSection[]): string {
  const sectionHtml = sections.map(s => {
    const cols = s.columns
    let tableHtml = ''
    if (cols && cols.length > 0) {
      const ths = cols.map(c =>
        `<th style="text-align:${c.align ?? 'left'};padding:4px 8px;border-bottom:1px solid #999;font-size:11px;font-weight:600;white-space:nowrap;">${esc(c.header)}</th>`
      ).join('')
      const thead = `<thead><tr>${ths}</tr></thead>`

      const trs = s.rows.map(r => {
        const topBorder = r.doubleSeparator
          ? 'border-top:3px double #333;'
          : r.separator
            ? 'border-top:1px solid #999;'
            : ''
        const weight = r.bold ? 'font-weight:700;' : ''
        const colour = r.color === 'green' ? 'color:#15803d;' : r.color === 'red' ? 'color:#dc2626;' : ''
        const tds = r.cells.map((cell, ci) => {
          const col = cols[ci]
          const align = col?.align ?? 'left'
          const wrap = col?.nowrap ? 'white-space:nowrap;' : 'word-break:break-word;'
          const indent = r.indent && ci === 0 ? 'padding-left:24px;' : ''
          return `<td style="text-align:${align};padding:3px 8px;${wrap}${indent}${weight}${colour}">${esc(cell)}</td>`
        }).join('')
        return `<tr style="${topBorder}${weight}">${tds}</tr>`
      }).join('')

      tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px;"><${thead}<tbody>${trs}</tbody></table>`
    }
    const heading = s.title ? `<h3 style="font-size:12px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.5px;color:#555;">${esc(s.title)}</h3>` : ''
    return heading + tableHtml
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  /* margin:0 on @page suppresses browser's built-in URL/date headers/footers */
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 11px; color: #111;
         /* Replace @page margin with body margin so content is still inset */
         margin: 15mm 12mm; padding: 0; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 13px; font-weight: 400; color: #555; margin: 0 0 12px; }
  table { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head><body>
<h1>${esc(title)}</h1>
${subtitle ? `<h2>${esc(subtitle)}</h2>` : ''}
${sectionHtml}
<div style="margin-top:20px;font-size:9px;color:#999;">Generated ${esc(formatDate(new Date()))}</div>
</body></html>`
}

/** @deprecated Use generateReportPdf for proper formatted reports */
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
