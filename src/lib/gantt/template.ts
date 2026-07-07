// Built-in "standard video production" schedule template.
// Offsets are expressed in business days from the anchor date (day 0), so a
// schedule seeded on any weekday lands on sensible weekdays. When the schedule
// includes weekends, offsets are applied as plain calendar days instead.
//
// This is the single file to tweak when the standard production flow changes.

import { addBusinessDays, addDays, rollToBusinessDay } from './dates'
import type { ScheduleTaskKind, ScheduleTaskOwner } from './types'

export interface TemplateTask {
  name: string
  description?: string
  kind: ScheduleTaskKind
  owner: ScheduleTaskOwner
  /** Business-day offset from the anchor date. */
  startBd: number
  /** Duration in business days (BAR only, default 1). */
  durationBd?: number
  showDeadline?: boolean
}

export interface TemplatePhase {
  name: string
  color: string
  tasks: TemplateTask[]
}

export const STANDARD_VIDEO_TEMPLATE: { phases: TemplatePhase[] } = {
  phases: [
    {
      name: 'Pre-production',
      color: '#7C6FD8',
      tasks: [
        {
          name: 'Project confirmation',
          description: 'Confirmed to begin scheduling and planning.',
          kind: 'MILESTONE',
          owner: 'CLIENT',
          startBd: 0,
        },
        {
          name: 'Planning & shot list',
          description: 'Shots and schedule finalized ahead of the shoot.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 1,
          durationBd: 3,
          showDeadline: true,
        },
      ],
    },
    {
      name: 'Production',
      color: '#C0392B',
      tasks: [
        {
          name: 'Filming day',
          description: 'Content is captured on location or in studio.',
          kind: 'MILESTONE',
          owner: 'STUDIO',
          startBd: 5,
        },
      ],
    },
    {
      name: 'Post-production',
      color: '#12A150',
      tasks: [
        {
          name: 'Edit — V1',
          description: 'First cut assembled for review.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 6,
          durationBd: 4,
          showDeadline: true,
        },
        {
          name: 'V1 — client review',
          description: 'Feedback provided so revisions can begin.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 11,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'Edit — V2',
          description: 'Revisions incorporating feedback from the V1 review.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 14,
          durationBd: 3,
          showDeadline: true,
        },
        {
          name: 'V2 — client review',
          description: 'Feedback provided for the final round of revisions.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 18,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'Final round of included revisions',
          description: 'Last set of revisions incorporating the V2 feedback.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 21,
          durationBd: 2,
          showDeadline: true,
        },
      ],
    },
    {
      name: 'Delivery',
      color: '#2478CC',
      tasks: [
        {
          name: 'Provide final versions',
          description: 'Signed-off final files delivered.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 24,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'Project complete',
          description: 'Project wrapped.',
          kind: 'MILESTONE',
          owner: 'STUDIO',
          startBd: 27,
        },
      ],
    },
  ],
}

/**
 * Materialize the template into a Prisma nested-create payload for
 * projectSchedule.create({ data: { ..., phases: materializeTemplate(...) } }).
 */
export function materializeTemplate(anchorDate: string, includeWeekends: boolean) {
  const offset = (startBd: number) =>
    includeWeekends ? addDays(anchorDate, startBd) : addBusinessDays(anchorDate, startBd)

  const spanEnd = (startISO: string, durationBd: number) => {
    if (durationBd <= 1) return startISO
    return includeWeekends
      ? addDays(startISO, durationBd - 1)
      : addBusinessDays(startISO, durationBd - 1)
  }

  return {
    create: STANDARD_VIDEO_TEMPLATE.phases.map((phase, phaseIdx) => ({
      name: phase.name,
      color: phase.color,
      sortOrder: phaseIdx,
      tasks: {
        create: phase.tasks.map((task, taskIdx) => {
          const start = includeWeekends
            ? offset(task.startBd)
            : rollToBusinessDay(offset(task.startBd))
          const end = task.kind === 'MILESTONE' ? start : spanEnd(start, task.durationBd ?? 1)
          return {
            name: task.name,
            description: task.description ?? null,
            kind: task.kind,
            owner: task.owner,
            startDate: start,
            endDate: end,
            showDeadline: task.showDeadline ?? false,
            sortOrder: taskIdx,
          }
        }),
      },
    })),
  }
}
