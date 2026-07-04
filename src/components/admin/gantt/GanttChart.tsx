'use client'

// SVG renderer for the production-schedule Gantt layout. All geometry comes
// from computeGanttLayout() (shared with the PDF drawer) — this component only
// paints it.

import React from 'react'
import type { GanttLayout, GanttTaskRow } from '@/lib/gantt/types'

const COLORS = {
  axisBg: '#F1EFEA',
  axisText: '#6B6B6B',
  weekendShade: '#00000010',
  grid: '#E4E1DA',
  rowLine: '#ECEAE4',
  phaseBg: '#EFEDE7',
  phaseText: '#5A5A5A',
  taskName: '#1F1F1F',
  taskDesc: '#8A8A8A',
  deadline: '#3A3A3A',
  paper: '#FFFFFF',
}

interface GanttChartProps {
  layout: GanttLayout
  /** Display magnification — the SVG renders at layout size × scale. */
  scale?: number
  editable?: boolean
  onTaskClick?: (row: GanttTaskRow) => void
  onPhaseClick?: (phaseId: string) => void
}

export default function GanttChart({ layout, scale = 1, editable, onTaskClick, onPhaseClick }: GanttChartProps) {
  const { header, axis, days, weeks, rows, legend, labelColWidth, totalWidth, totalHeight } = layout
  const contentTop = header.height + axis.height
  const contentBottom = legend.y - 2

  return (
    <svg
      viewBox={`0 0 ${totalWidth} ${totalHeight}`}
      width={totalWidth * scale}
      height={totalHeight * scale}
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: COLORS.paper, display: 'block' }}
      role="img"
      aria-label={header.title}
    >
      {/* Header band */}
      <rect x={0} y={0} width={totalWidth} height={header.height} fill={header.bg} />
      <text x={12} y={22} fill={header.textColor} fontSize={13} fontWeight={700} fontFamily="Helvetica, Arial, sans-serif">
        {header.title}
      </text>
      <text x={12} y={40} fill={header.subColor} fontSize={8} fontFamily="Helvetica, Arial, sans-serif">
        {header.subtitle}
      </text>
      <text x={totalWidth - 12} y={22} fill={header.subColor} fontSize={8} textAnchor="end" fontFamily="Helvetica, Arial, sans-serif">
        {header.generated}
      </text>

      {/* Axis background */}
      <rect x={0} y={axis.weekRowY} width={totalWidth} height={axis.height} fill={COLORS.axisBg} />
      <text x={12} y={axis.dayRowY + 11} fill={COLORS.axisText} fontSize={7} fontWeight={700} letterSpacing={0.8} fontFamily="Helvetica, Arial, sans-serif">
        TASK
      </text>

      {/* Week group headers */}
      {weeks.map((w, i) => (
        <React.Fragment key={`wk-${i}`}>
          {i > 0 && <line x1={w.x} y1={axis.weekRowY} x2={w.x} y2={contentBottom} stroke={COLORS.grid} strokeWidth={1} />}
          <text
            x={w.x + w.width / 2}
            y={axis.weekRowY + 11}
            fill={COLORS.axisText}
            fontSize={7}
            fontWeight={700}
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
          >
            {w.label}
          </text>
        </React.Fragment>
      ))}

      {/* Day columns */}
      {days.map((d) => (
        <React.Fragment key={d.date}>
          {d.isWeekend && (
            <rect x={d.x} y={axis.dayRowY} width={d.width} height={contentBottom - axis.dayRowY} fill={COLORS.weekendShade} />
          )}
          <text
            x={d.x + d.width / 2}
            y={axis.dayRowY + 10.5}
            fill={COLORS.axisText}
            fontSize={7}
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
          >
            {d.dayLabel}
          </text>
        </React.Fragment>
      ))}

      {/* Column grid */}
      {days.map((d) => (
        <line key={`g-${d.date}`} x1={d.x} y1={contentTop} x2={d.x} y2={contentBottom} stroke={COLORS.grid} strokeWidth={0.5} />
      ))}

      {/* Rows */}
      {rows.map((row) => {
        if (row.type === 'phase') {
          return (
            <g
              key={`ph-${row.phase.id}`}
              onClick={editable && onPhaseClick ? () => onPhaseClick(row.phase.id) : undefined}
              style={editable ? { cursor: 'pointer' } : undefined}
            >
              <rect x={0} y={row.y} width={totalWidth} height={row.height} fill={COLORS.phaseBg} />
              <rect x={8} y={row.y + 3} width={4} height={row.height - 6} fill={row.phase.color} />
              <text
                x={18}
                y={row.y + row.height / 2 + 2.5}
                fill={COLORS.phaseText}
                fontSize={7}
                fontWeight={700}
                letterSpacing={0.8}
                fontFamily="Helvetica, Arial, sans-serif"
              >
                {row.phase.name.toUpperCase()}
              </text>
            </g>
          )
        }

        const { task, bar, stripes, diamond, deadlineX } = row
        return (
          <g
            key={`t-${task.id}`}
            onClick={editable && onTaskClick ? () => onTaskClick(row) : undefined}
            style={editable ? { cursor: 'pointer' } : undefined}
          >
            {editable && (
              <rect x={0} y={row.y} width={totalWidth} height={row.height} fill="transparent" className="hover:fill-black/5" />
            )}
            <line x1={0} y1={row.y + row.height} x2={totalWidth} y2={row.y + row.height} stroke={COLORS.rowLine} strokeWidth={0.5} />

            {/* Label column */}
            <text x={12} y={row.y + 11} fill={COLORS.taskName} fontSize={8} fontWeight={700} fontFamily="Helvetica, Arial, sans-serif">
              {task.name}
            </text>
            {row.descriptionLines.map((line, i) => (
              <text
                key={i}
                x={12}
                y={row.y + 19.5 + i * 8.5}
                fill={COLORS.taskDesc}
                fontSize={6.5}
                fontFamily="Helvetica, Arial, sans-serif"
              >
                {line}
              </text>
            ))}

            {/* Bar */}
            {bar && !stripes && (
              <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill={row.phaseColor} />
            )}
            {bar && stripes && (
              <>
                <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill="#FFFFFF" stroke={row.phaseColor} strokeWidth={1} />
                {stripes.map((s, i) => (
                  <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={row.phaseColor} strokeWidth={1.4} />
                ))}
              </>
            )}

            {/* Milestone diamond */}
            {diamond && (
              <rect
                x={diamond.cx - diamond.r}
                y={diamond.cy - diamond.r}
                width={diamond.r * 2}
                height={diamond.r * 2}
                fill={row.phaseColor}
                transform={`rotate(45 ${diamond.cx} ${diamond.cy})`}
              />
            )}

            {/* Deadline marker at bar end */}
            {bar && deadlineX !== undefined && (
              <>
                <line x1={deadlineX} y1={bar.y - 2} x2={deadlineX} y2={bar.y + bar.height + 2} stroke={COLORS.deadline} strokeWidth={1.6} />
                <path
                  d={`M ${deadlineX - 2.5} ${bar.y + bar.height / 2} l -4 -3 v 6 z`}
                  fill={COLORS.deadline}
                />
              </>
            )}
          </g>
        )
      })}

      {/* Legend */}
      <line x1={12} y1={legend.y - 2} x2={totalWidth - 12} y2={legend.y - 2} stroke={COLORS.grid} strokeWidth={0.5} />
      {(() => {
        const phaseItems = legend.items.filter((i) => i.kind === 'phase')
        const ownerItems = legend.items.filter((i) => i.kind !== 'phase')
        const swatchW = 18
        const swatchH = 7
        const rowY1 = legend.y + 8
        const rowY2 = rowY1 + 14
        let x1 = 60
        let x2 = 60
        return (
          <>
            <text x={12} y={rowY1 + 6} fill={COLORS.axisText} fontSize={6.5} fontWeight={700} letterSpacing={0.6} fontFamily="Helvetica, Arial, sans-serif">
              PHASE
            </text>
            {phaseItems.map((item, i) => {
              const x = x1
              x1 += swatchW + 8 + item.label.length * 3.6 + 16
              return (
                <g key={`lp-${i}`}>
                  <rect x={x} y={rowY1} width={swatchW} height={swatchH} rx={3} fill={item.color} />
                  <text x={x + swatchW + 5} y={rowY1 + 6} fill={COLORS.taskName} fontSize={6.5} fontFamily="Helvetica, Arial, sans-serif">
                    {item.label}
                  </text>
                </g>
              )
            })}
            <text x={12} y={rowY2 + 6} fill={COLORS.axisText} fontSize={6.5} fontWeight={700} letterSpacing={0.6} fontFamily="Helvetica, Arial, sans-serif">
              OWNER
            </text>
            {ownerItems.map((item, i) => {
              const x = x2
              x2 += swatchW + 8 + item.label.length * 3.6 + 16
              return (
                <g key={`lo-${i}`}>
                  {item.kind === 'solid' && <rect x={x} y={rowY2} width={swatchW} height={swatchH} rx={3} fill={item.color} />}
                  {item.kind === 'striped' && (
                    <>
                      <rect x={x} y={rowY2} width={swatchW} height={swatchH} rx={3} fill="#FFFFFF" stroke={item.color} strokeWidth={1} />
                      <line x1={x + 4} y1={rowY2 + swatchH} x2={x + 4 + swatchH} y2={rowY2} stroke={item.color} strokeWidth={1.2} />
                      <line x1={x + 9} y1={rowY2 + swatchH} x2={x + 9 + swatchH} y2={rowY2} stroke={item.color} strokeWidth={1.2} />
                    </>
                  )}
                  {item.kind === 'period' && <rect x={x} y={rowY2} width={swatchW} height={swatchH} rx={3} fill={item.color} />}
                  {item.kind === 'keydate' && (
                    <rect
                      x={x + swatchW / 2 - 3.5}
                      y={rowY2 + swatchH / 2 - 3.5}
                      width={7}
                      height={7}
                      fill={item.color}
                      transform={`rotate(45 ${x + swatchW / 2} ${rowY2 + swatchH / 2})`}
                    />
                  )}
                  <text x={x + swatchW + 5} y={rowY2 + 6} fill={COLORS.taskName} fontSize={6.5} fontFamily="Helvetica, Arial, sans-serif">
                    {item.label}
                  </text>
                </g>
              )
            })}
          </>
        )
      })()}
    </svg>
  )
}
