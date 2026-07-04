// Shared DTO + layout types for the per-project production schedule (Gantt chart).
// The layout types are produced by computeGanttLayout() and consumed by both the
// on-screen SVG renderer and the pdf-lib drawer so the two outputs match exactly.

export type ScheduleTaskKind = 'BAR' | 'MILESTONE'
export type ScheduleTaskOwner = 'STUDIO' | 'CLIENT'

export interface ScheduleTaskDTO {
  id: string
  name: string
  description: string | null
  kind: ScheduleTaskKind
  owner: ScheduleTaskOwner
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD (== startDate for MILESTONE)
  showDeadline: boolean
  sortOrder: number
}

export interface SchedulePhaseDTO {
  id: string
  name: string
  color: string // #RRGGBB
  sortOrder: number
  tasks: ScheduleTaskDTO[]
}

export interface ScheduleDTO {
  id: string
  projectId: string
  title: string | null
  includeWeekends: boolean
  phases: SchedulePhaseDTO[]
}

// ---------------------------------------------------------------------------
// Layout geometry (units: points, origin top-left, y grows downward)
// ---------------------------------------------------------------------------

export interface GanttSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GanttDayColumn {
  date: string // YYYY-MM-DD
  x: number
  width: number
  dayLabel: string // "3", "14"
  isWeekend: boolean
}

export interface GanttWeekGroup {
  label: string // "6 Jul week" or "3 Jul" for a partial leading group
  x: number
  width: number
}

export interface GanttPhaseRow {
  type: 'phase'
  phase: SchedulePhaseDTO
  y: number
  height: number
}

export interface GanttTaskRow {
  type: 'task'
  task: ScheduleTaskDTO
  phaseColor: string
  y: number
  height: number
  /** Wrapped description lines (already measured for the label column). */
  descriptionLines: string[]
  /** Present when kind === 'BAR'. */
  bar?: { x: number; width: number; y: number; height: number }
  /** Diagonal stripe segments pre-clipped to the bar rect (CLIENT-owned bars). */
  stripes?: GanttSegment[]
  /** Present when kind === 'MILESTONE'. */
  diamond?: { cx: number; cy: number; r: number }
  /** X of the deadline marker at the bar end (showDeadline). */
  deadlineX?: number
}

export type GanttRow = GanttPhaseRow | GanttTaskRow

export interface GanttLegendItem {
  kind: 'phase' | 'solid' | 'striped' | 'period' | 'keydate'
  label: string
  color: string
}

export interface GanttLayout {
  header: {
    title: string
    subtitle: string // "3 July – 30 July 2026  ·  Weekdays only"
    generated: string // "Generated 3 July 2026"
    height: number
    bg: string // header band background (#RRGGBB) — from Email header colour
    textColor: string // title/primary text (#RRGGBB)
    subColor: string // muted subtitle text (#RRGGBB)
  }
  axis: {
    weekRowY: number
    weekRowHeight: number
    dayRowY: number
    dayRowHeight: number
    height: number // weekRowHeight + dayRowHeight
  }
  labelColWidth: number
  days: GanttDayColumn[]
  weeks: GanttWeekGroup[]
  rows: GanttRow[]
  legend: {
    items: GanttLegendItem[]
    y: number
    height: number
  }
  totalWidth: number
  totalHeight: number
}
