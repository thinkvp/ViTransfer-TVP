// pdf-lib drawer for the production-schedule Gantt chart. Consumes the same
// GanttLayout geometry as the on-screen SVG renderer (see layout.ts), so the
// exported PDF matches the screen exactly. Runs client-side (Export button),
// mirroring the sales quote/invoice download flow in src/lib/sales/pdf.ts.

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import { GANTT_METRICS, computeGanttLayout, type GanttLayoutOptions } from './layout'
import { paginateGanttLayout } from './paginate'
import type { GanttRow, ScheduleDTO } from './types'

const PAGE_W = 841.89 // A4 landscape
const PAGE_H = 595.28
const MARGIN = 24
const FOOTER_H = 18

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0x888888
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
}

const COLORS = {
  axisBg: hexToRgb('#F1EFEA'),
  axisText: hexToRgb('#6B6B6B'),
  weekendShade: hexToRgb('#E9E7E1'),
  grid: hexToRgb('#E4E1DA'),
  rowLine: hexToRgb('#ECEAE4'),
  phaseBg: hexToRgb('#EFEDE7'),
  phaseText: hexToRgb('#5A5A5A'),
  taskName: hexToRgb('#1F1F1F'),
  taskDesc: hexToRgb('#8A8A8A'),
  deadline: hexToRgb('#3A3A3A'),
  white: rgb(1, 1, 1),
}

// The standard Helvetica fonts only encode WinAnsi (cp1252). Map common
// non-encodable characters to close equivalents so drawText never throws.
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])
const CHAR_MAP: Record<string, string> = {
  '→': '-', '←': '-', '↔': '-', '⇒': '-', '⇐': '-',
  '‣': '•', '·': '·', '✓': 'v', '✔': 'v', '★': '*', '☆': '*',
}
function winAnsiSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    if (CHAR_MAP[ch] !== undefined) {
      out += CHAR_MAP[ch]
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    out += cp <= 0xff || WINANSI_EXTRA.has(cp) ? ch : '?'
  }
  return out
}

function detectImageKind(contentType: string | null, bytes: Uint8Array): 'png' | 'jpg' | null {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'png'
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  return null
}

async function tryEmbedLogo(doc: PDFDocument) {
  try {
    const res = await fetch('/api/branding/logo', {
      cache: 'no-store',
      headers: { Accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1' },
    })
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!bytes.length) return null
    const kind = detectImageKind(res.headers.get('content-type'), bytes)
    if (!kind) return null
    return kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  } catch {
    return null
  }
}

export async function buildGanttPdfBytes(schedule: ScheduleDTO, layoutOpts: GanttLayoutOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const logo = await tryEmbedLogo(doc)

  const M = GANTT_METRICS
  const availHeight = PAGE_H - MARGIN * 2 - FOOTER_H
  const contentWidth = PAGE_W - MARGIN * 2

  // Pick the page scale from the chart HEIGHT (row heights don't depend on
  // column width): fit a modest overflow onto one page, otherwise paginate at
  // full size. Then stretch the day columns so the timeline fills the page
  // width at that scale instead of leaving blank space on the right.
  const base = computeGanttLayout(schedule, layoutOpts)
  const dayCount = base.days.length
  let s = Math.min(1, availHeight / base.totalHeight)
  if (s < 0.6) s = 1

  let colWidth = (contentWidth / s - M.labelColWidth) / dayCount
  if (colWidth < M.colWidth) {
    // Very long timeline: keep columns readable and shrink to fit width instead
    colWidth = M.colWidth
    s = Math.min(s, contentWidth / (M.labelColWidth + dayCount * M.colWidth))
  }

  const layout = computeGanttLayout(schedule, { ...layoutOpts, colWidth })
  const contentTop = layout.header.height + layout.axis.height
  const maxContentHeight = availHeight / s - contentTop

  const pages = paginateGanttLayout(layout, maxContentHeight)

  for (const pageSpec of pages) {
    const page = doc.addPage([PAGE_W, PAGE_H])

    // Layout(top-left, y-down) -> PDF(bottom-left, y-up)
    const tx = (x: number) => MARGIN + x * s
    const ty = (y: number) => PAGE_H - MARGIN - y * s
    const localY = (y: number) => y - pageSpec.translateY

    const text = (
      str: string,
      x: number,
      yBaseline: number,
      size: number,
      f = font,
      color = COLORS.taskName,
      opts?: { rightAlign?: boolean }
    ) => {
      const safe = winAnsiSafe(str)
      const scaled = size * s
      let px = tx(x)
      if (opts?.rightAlign) px -= f.widthOfTextAtSize(safe, scaled)
      page.drawText(safe, { x: px, y: ty(yBaseline), size: scaled, font: f, color })
    }

    const rect = (x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>, opts?: { border?: ReturnType<typeof rgb> }) => {
      page.drawRectangle({
        x: tx(x),
        y: ty(y + h),
        width: w * s,
        height: h * s,
        color: opts?.border ? COLORS.white : color,
        ...(opts?.border ? { borderColor: opts.border, borderWidth: 1 * s } : {}),
      })
    }

    const line = (x1: number, y1: number, x2: number, y2: number, thickness: number, color: ReturnType<typeof rgb>) => {
      page.drawLine({
        start: { x: tx(x1), y: ty(y1) },
        end: { x: tx(x2), y: ty(y2) },
        thickness: thickness * s,
        color,
      })
    }

    const rowsEnd = pageSpec.rows.length
      ? localY(pageSpec.rows[pageSpec.rows.length - 1].y + pageSpec.rows[pageSpec.rows.length - 1].height)
      : contentTop

    const legendY = rowsEnd + M.legendPad
    const contentBottom = pageSpec.includeLegend ? legendY - 2 : rowsEnd

    // --- Header band --- (colours come from the admin Email-header setting)
    rect(0, 0, layout.totalWidth, layout.header.height, hexToRgb(layout.header.bg))
    text(layout.header.title, 12, 25, 13, bold, hexToRgb(layout.header.textColor))
    text(layout.header.subtitle, 12, 42, 8, font, hexToRgb(layout.header.subColor))
    if (logo) {
      const logoH = 24
      const dims = logo.scale((logoH * s) / logo.height)
      page.drawImage(logo, {
        x: tx(layout.totalWidth - 12) - dims.width,
        y: ty(layout.header.height - 8),
        width: dims.width,
        height: dims.height,
      })
    }

    // --- Axis ---
    rect(0, layout.axis.weekRowY, layout.totalWidth, layout.axis.height, COLORS.axisBg)
    text('TASK', 12, layout.axis.dayRowY + 11, 7, bold, COLORS.axisText)
    for (const [i, w] of layout.weeks.entries()) {
      if (i > 0) line(w.x, layout.axis.weekRowY, w.x, contentBottom, 1, COLORS.grid)
      const labelW = bold.widthOfTextAtSize(w.label, 7 * s) / s
      text(w.label, w.x + w.width / 2 - labelW / 2, layout.axis.weekRowY + 11, 7, bold, COLORS.axisText)
    }
    for (const d of layout.days) {
      if (d.isWeekend) {
        rect(d.x, layout.axis.dayRowY, d.width, contentBottom - layout.axis.dayRowY, COLORS.weekendShade)
      }
      const labelW = font.widthOfTextAtSize(d.dayLabel, 7 * s) / s
      text(d.dayLabel, d.x + d.width / 2 - labelW / 2, layout.axis.dayRowY + 10.5, 7, font, COLORS.axisText)
      line(d.x, contentTop, d.x, contentBottom, 0.5, COLORS.grid)
    }

    // --- Rows ---
    for (const row of pageSpec.rows as GanttRow[]) {
      const yTop = localY(row.y)

      if (row.type === 'phase') {
        rect(0, yTop, layout.totalWidth, row.height, COLORS.phaseBg)
        rect(8, yTop + 3, 4, row.height - 6, hexToRgb(row.phase.color))
        text(row.phase.name.toUpperCase(), 18, yTop + row.height / 2 + 2.5, 7, bold, COLORS.phaseText)
        continue
      }

      const { task, bar, stripes, diamond, deadlineX } = row
      const phaseColor = hexToRgb(row.phaseColor)

      line(0, yTop + row.height, layout.totalWidth, yTop + row.height, 0.5, COLORS.rowLine)
      text(task.name, 12, yTop + 11, 8, bold, COLORS.taskName)
      row.descriptionLines.forEach((descLine, i) => {
        text(descLine, 12, yTop + 19.5 + i * M.descLineHeight, 6.5, font, COLORS.taskDesc)
      })

      const dy = row.y - yTop // shift layout-space geometry into page space

      if (bar && !stripes) {
        rect(bar.x, bar.y - dy, bar.width, bar.height, phaseColor)
      }
      if (bar && stripes) {
        rect(bar.x, bar.y - dy, bar.width, bar.height, COLORS.white, { border: phaseColor })
        for (const seg of stripes) {
          line(seg.x1, seg.y1 - dy, seg.x2, seg.y2 - dy, 1.4, phaseColor)
        }
      }
      if (diamond) {
        // A square rotated 45° about its corner has its centre at corner+(0, r),
        // so anchoring the corner at (cx, cy − r) centres the diamond on (cx, cy).
        const r = diamond.r * s
        page.drawRectangle({
          x: tx(diamond.cx),
          y: ty(diamond.cy - dy) - r,
          width: r * Math.SQRT2,
          height: r * Math.SQRT2,
          color: phaseColor,
          rotate: degrees(45),
        })
      }
      if (bar && deadlineX !== undefined) {
        line(deadlineX, bar.y - dy - 2, deadlineX, bar.y - dy + bar.height + 2, 1.6, COLORS.deadline)
        page.drawSvgPath('M 0 0 L 4 -3 L 4 3 Z', {
          x: tx(deadlineX - 6.5),
          y: ty(bar.y - dy + bar.height / 2),
          scale: s,
          color: COLORS.deadline,
        })
      }
    }

    // --- Legend ---
    if (pageSpec.includeLegend) {
      line(12, legendY - 2, layout.totalWidth - 12, legendY - 2, 0.5, COLORS.grid)
      const phaseItems = layout.legend.items.filter((i) => i.kind === 'phase')
      const ownerItems = layout.legend.items.filter((i) => i.kind !== 'phase')
      const swatchW = 18
      const swatchH = 7
      const rowY1 = legendY + 8
      const rowY2 = rowY1 + 14

      text('PHASE', 12, rowY1 + 6, 6.5, bold, COLORS.axisText)
      let x = 60
      for (const item of phaseItems) {
        rect(x, rowY1, swatchW, swatchH, hexToRgb(item.color))
        text(item.label, x + swatchW + 5, rowY1 + 6, 6.5, font, COLORS.taskName)
        x += swatchW + 8 + item.label.length * 3.6 + 16
      }

      text('OWNER', 12, rowY2 + 6, 6.5, bold, COLORS.axisText)
      x = 60
      for (const item of ownerItems) {
        const c = hexToRgb(item.color)
        if (item.kind === 'solid' || item.kind === 'period') {
          rect(x, rowY2, swatchW, swatchH, c)
        } else if (item.kind === 'striped') {
          rect(x, rowY2, swatchW, swatchH, COLORS.white, { border: c })
          line(x + 4, rowY2 + swatchH, x + 4 + swatchH, rowY2, 1.2, c)
          line(x + 9, rowY2 + swatchH, x + 9 + swatchH, rowY2, 1.2, c)
        } else {
          const cx = x + swatchW / 2
          const cy = rowY2 + swatchH / 2
          const r = 3.5 * s
          page.drawRectangle({
            x: tx(cx),
            y: ty(cy) - r,
            width: r * Math.SQRT2,
            height: r * Math.SQRT2,
            color: c,
            rotate: degrees(45),
          })
        }
        text(item.label, x + swatchW + 5, rowY2 + 6, 6.5, font, COLORS.taskName)
        x += swatchW + 8 + item.label.length * 3.6 + 16
      }
    }
  }

  // Footer: "Generated ..." on the left (moved out of the header so it can't
  // clash with the company logo), page numbers on the right.
  const allPages = doc.getPages()
  allPages.forEach((p, idx) => {
    const size = 8
    p.drawText(winAnsiSafe(layout.header.generated), {
      x: MARGIN,
      y: 12,
      size,
      font,
      color: COLORS.axisText,
    })
    const label = `Page ${idx + 1} of ${allPages.length}`
    p.drawText(label, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, size),
      y: 12,
      size,
      font,
      color: COLORS.axisText,
    })
  })

  return doc.save()
}

export async function downloadGanttPdf(schedule: ScheduleDTO, layoutOpts: GanttLayoutOptions, filename: string) {
  const bytes = await buildGanttPdfBytes(schedule, layoutOpts)
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
