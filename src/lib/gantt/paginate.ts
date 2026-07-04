// Splits a Gantt layout into PDF pages. Each page repeats the header band and
// week/day axis; the legend lands on the last page. On screen the SVG renders
// the layout unpaginated, so this is only used by the pdf drawer.

import type { GanttLayout, GanttRow } from './types'

export interface GanttPage {
  rows: GanttRow[]
  /** Subtract from each row's y to re-anchor it below the axis on this page. */
  translateY: number
  includeLegend: boolean
}

export function paginateGanttLayout(layout: GanttLayout, maxContentHeight: number): GanttPage[] {
  const contentTop = layout.header.height + layout.axis.height
  const legendSpace = layout.legend.height + 6

  const pages: GanttPage[] = []
  let current: GanttRow[] = []
  let pageStartY = contentTop

  const flush = () => {
    if (current.length === 0) return
    pages.push({ rows: current, translateY: pageStartY - contentTop, includeLegend: false })
    current = []
  }

  for (const row of layout.rows) {
    const usedHeight = row.y + row.height - pageStartY
    if (current.length > 0 && usedHeight > maxContentHeight) {
      flush()
      pageStartY = row.y
    }
    current.push(row)
  }
  flush()

  if (pages.length === 0) {
    pages.push({ rows: [], translateY: 0, includeLegend: true })
    return pages
  }

  // Legend on the last page; spill to a fresh page if it doesn't fit
  const last = pages[pages.length - 1]
  const lastRowsEnd = last.rows.length
    ? last.rows[last.rows.length - 1].y + last.rows[last.rows.length - 1].height - last.translateY
    : contentTop
  if (lastRowsEnd - contentTop + legendSpace <= maxContentHeight) {
    last.includeLegend = true
  } else {
    pages.push({ rows: [], translateY: 0, includeLegend: true })
  }

  return pages
}
