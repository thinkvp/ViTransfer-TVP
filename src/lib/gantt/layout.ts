// Pure layout engine for the production schedule Gantt chart.
// Produces positioned geometry (points, y-down) consumed by BOTH the on-screen
// SVG renderer and the pdf-lib drawer, so the two outputs match exactly.

import {
  addDays,
  compareISO,
  dayNumber,
  enumerateScheduleDays,
  formatLongDate,
  formatShortDate,
  isWeekend,
  toISODate,
  weekLabel,
  weekStart,
  weekdayIndex,
} from './dates'
import type {
  GanttDayColumn,
  GanttLayout,
  GanttLegendItem,
  GanttRow,
  GanttSegment,
  GanttTaskRow,
  GanttWeekGroup,
  ScheduleDTO,
} from './types'

export interface GanttLayoutOptions {
  projectTitle: string
  /** Company/studio name for the "solid = our action" legend entry. */
  studioName?: string
  /** ISO date used for the "Generated ..." stamp; defaults to today. */
  today?: string
  /** Day-column width override (points). The PDF drawer stretches columns to fill the page. */
  colWidth?: number
  /** Header band background (#RRGGBB) — the admin "Email header colour" setting. */
  headerColor?: string | null
  /** Header text mode — the admin "Email header text" setting. */
  headerTextMode?: 'LIGHT' | 'DARK' | null
}

// Defaults mirror the email header (EMAIL_THEME.headerBackground / LIGHT text).
const DEFAULT_HEADER_BG = '#1F1F1F'

function normalizeHex(hex: string | null | undefined, fallback: string): string {
  if (!hex) return fallback
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  return m ? `#${m[1]}` : fallback
}

/** Mix two #RRGGBB colours; t=0 → a, t=1 → b. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const mix = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t)
  const r = mix((pa >> 16) & 0xff, (pb >> 16) & 0xff)
  const g = mix((pa >> 8) & 0xff, (pb >> 8) & 0xff)
  const bl = mix(pa & 0xff, pb & 0xff)
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
}

// Metrics (points). Tuned to echo the reference PDF at A4-landscape scale.
export const GANTT_METRICS = {
  labelColWidth: 200,
  colWidth: 24,
  headerHeight: 52,
  weekRowHeight: 16,
  dayRowHeight: 15,
  phaseRowHeight: 15,
  taskNameSize: 8,
  taskDescSize: 6.5,
  descLineHeight: 8.5,
  taskRowBase: 15, // name line + padding
  taskRowPad: 5,
  barHeight: 9,
  diamondRadius: 5,
  stripeSpacing: 5,
  legendRowHeight: 14,
  legendPad: 8,
  minTimelineDays: 10,
}

/** Greedy word-wrap using an average Helvetica width estimate (renderer-agnostic). */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const avgCharWidth = fontSize * 0.5
  const maxChars = Math.max(8, Math.floor(maxWidth / avgCharWidth))
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word
    if (candidate.length <= maxChars) {
      cur = candidate
    } else {
      if (cur) lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3) // cap description depth so rows stay compact
}

/** Diagonal stripe segments (45°, x+y = c family) clipped to a rect in pure math. */
function stripeSegments(x: number, y: number, w: number, h: number, spacing: number): GanttSegment[] {
  const out: GanttSegment[] = []
  const cStart = Math.ceil((x + y) / spacing) * spacing
  const cEnd = x + w + y + h
  for (let c = cStart; c <= cEnd; c += spacing) {
    const px1 = Math.max(x, c - (y + h))
    const px2 = Math.min(x + w, c - y)
    if (px1 < px2) {
      out.push({ x1: px1, y1: c - px1, x2: px2, y2: c - px2 })
    }
  }
  return out
}

/** Clamp a date into the visible day set (weekends roll inward when hidden). */
function clampStart(iso: string, includeWeekends: boolean): string {
  if (includeWeekends) return iso
  const wd = weekdayIndex(iso)
  if (wd === 5) return addDays(iso, 2)
  if (wd === 6) return addDays(iso, 1)
  return iso
}

function clampEnd(iso: string, includeWeekends: boolean): string {
  if (includeWeekends) return iso
  const wd = weekdayIndex(iso)
  if (wd === 5) return addDays(iso, -1)
  if (wd === 6) return addDays(iso, -2)
  return iso
}

export function computeGanttLayout(schedule: ScheduleDTO, opts: GanttLayoutOptions): GanttLayout {
  const M = GANTT_METRICS
  const colWidth = opts.colWidth ?? M.colWidth
  const todayISO = opts.today ?? toISODate(new Date())
  const includeWeekends = schedule.includeWeekends

  const allTasks = schedule.phases.flatMap((p) => p.tasks)

  // Visible date range
  let minDate = todayISO
  let maxDate = addDays(todayISO, M.minTimelineDays)
  if (allTasks.length > 0) {
    minDate = allTasks.reduce((m, t) => (compareISO(t.startDate, m) < 0 ? t.startDate : m), allTasks[0].startDate)
    maxDate = allTasks.reduce((m, t) => (compareISO(t.endDate, m) > 0 ? t.endDate : m), allTasks[0].endDate)
  }
  minDate = clampStart(minDate, includeWeekends)
  maxDate = clampEnd(maxDate, includeWeekends)
  if (compareISO(maxDate, minDate) < 0) maxDate = minDate

  const dayISOs = enumerateScheduleDays(minDate, maxDate, includeWeekends)

  // Day columns + index lookup
  const days: GanttDayColumn[] = dayISOs.map((iso, i) => ({
    date: iso,
    x: M.labelColWidth + i * colWidth,
    width: colWidth,
    dayLabel: dayNumber(iso),
    isWeekend: isWeekend(iso),
  }))
  const dayIndex = new Map<string, number>(dayISOs.map((iso, i) => [iso, i]))

  // Week grouping headers
  const weeks: GanttWeekGroup[] = []
  for (const day of days) {
    const ws = weekStart(day.date)
    const last = weeks[weeks.length - 1]
    if (last && (last as any)._weekStart === ws) {
      last.width += day.width
    } else {
      const isPartial = day.date !== ws
      const group: GanttWeekGroup & { _weekStart?: string } = {
        label: isPartial ? formatShortDate(day.date) : weekLabel(ws),
        x: day.x,
        width: day.width,
      }
      group._weekStart = ws
      weeks.push(group)
    }
  }
  weeks.forEach((w) => delete (w as any)._weekStart)

  // Rows
  const headerHeight = M.headerHeight
  const axisHeight = M.weekRowHeight + M.dayRowHeight
  const contentTop = headerHeight + axisHeight
  const descMaxWidth = M.labelColWidth - 14

  const rows: GanttRow[] = []
  let y = contentTop

  for (const phase of schedule.phases) {
    rows.push({ type: 'phase', phase, y, height: M.phaseRowHeight })
    y += M.phaseRowHeight

    for (const task of phase.tasks) {
      const descriptionLines = task.description
        ? wrapText(task.description, descMaxWidth, M.taskDescSize)
        : []
      const height = M.taskRowBase + descriptionLines.length * M.descLineHeight + M.taskRowPad

      const row: GanttTaskRow = {
        type: 'task',
        task,
        phaseColor: phase.color,
        y,
        height,
        descriptionLines,
      }

      const startISO = clampStart(task.startDate, includeWeekends)
      const endISO = clampEnd(task.endDate, includeWeekends)
      const startIdx = dayIndex.get(startISO)
      const endIdxRaw = dayIndex.get(endISO)

      if (startIdx !== undefined) {
        const endIdx = endIdxRaw !== undefined ? Math.max(startIdx, endIdxRaw) : startIdx
        const rowCenterY = y + M.taskRowBase / 2 + 2

        if (task.kind === 'MILESTONE') {
          const col = days[startIdx]
          row.diamond = { cx: col.x + col.width / 2, cy: rowCenterY, r: M.diamondRadius }
        } else {
          const barX = days[startIdx].x + 2
          const barW = (endIdx - startIdx + 1) * colWidth - 4
          const barY = rowCenterY - M.barHeight / 2
          row.bar = { x: barX, width: barW, y: barY, height: M.barHeight }
          if (task.owner === 'CLIENT') {
            row.stripes = stripeSegments(barX, barY, barW, M.barHeight, M.stripeSpacing)
          }
          if (task.showDeadline) {
            row.deadlineX = barX + barW
          }
        }
      }

      rows.push(row)
      y += height
    }
  }

  // Legend. OWNER swatches are all neutral grey (they explain shape/fill, not
  // colour — bars take their phase colour); only the phase swatches are coloured.
  const ownerGrey = '#8A8F98'
  const legendItems: GanttLegendItem[] = [
    ...schedule.phases.map<GanttLegendItem>((p) => ({ kind: 'phase', label: p.name, color: p.color })),
    { kind: 'solid', label: `${opts.studioName || 'Studio'} action (solid)`, color: ownerGrey },
    { kind: 'striped', label: 'Client action (striped)', color: ownerGrey },
    { kind: 'period', label: 'period', color: ownerGrey },
    { kind: 'keydate', label: 'key date', color: ownerGrey },
  ]
  const legendHeight = M.legendPad * 2 + M.legendRowHeight * 2
  const legendY = y + M.legendPad

  const totalWidth = M.labelColWidth + days.length * colWidth
  const totalHeight = legendY + legendHeight

  const rangeLabel = `${formatLongDate(minDate)} – ${formatLongDate(maxDate)}`
  const subtitle = `${rangeLabel}   ·   ${includeWeekends ? 'Includes weekends' : 'Weekdays only'}`

  const headerBg = normalizeHex(opts.headerColor, DEFAULT_HEADER_BG)
  const headerTextColor = opts.headerTextMode === 'DARK' ? '#111827' : '#FFFFFF'
  const headerSubColor = mixHex(headerTextColor, headerBg, 0.4)

  return {
    header: {
      title: schedule.title || `${opts.projectTitle} — Production Schedule`,
      subtitle,
      generated: `Generated ${formatLongDate(todayISO)}`,
      height: headerHeight,
      bg: headerBg,
      textColor: headerTextColor,
      subColor: headerSubColor,
    },
    axis: {
      weekRowY: headerHeight,
      weekRowHeight: M.weekRowHeight,
      dayRowY: headerHeight + M.weekRowHeight,
      dayRowHeight: M.dayRowHeight,
      height: axisHeight,
    },
    labelColWidth: M.labelColWidth,
    days,
    weeks,
    rows,
    legend: { items: legendItems, y: legendY, height: legendHeight },
    totalWidth,
    totalHeight,
  }
}
