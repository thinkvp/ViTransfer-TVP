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
          description: 'Confirm to lock crew and order gear, with time to arrive and test.',
          kind: 'MILESTONE',
          owner: 'CLIENT',
          startBd: 0,
        },
        {
          name: 'Script sign-off',
          description: 'As close to final as possible so every shot can be planned to it.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 0,
          durationBd: 3,
          showDeadline: true,
        },
        {
          name: 'Site visit',
          description: 'Visit the location to plan shots and identify challenges ahead of the shoot.',
          kind: 'MILESTONE',
          owner: 'STUDIO',
          startBd: 3,
        },
        {
          name: 'Storyboard & shoot schedule',
          description: 'Prepared over the following days, ready for review before the shoot.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 3,
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
          description: 'Shoot follows the storyboard and shot list, planned in advance.',
          kind: 'MILESTONE',
          owner: 'STUDIO',
          startBd: 8,
        },
      ],
    },
    {
      name: 'Post-production',
      color: '#12A150',
      tasks: [
        {
          name: 'Edit — V1',
          description: 'First cut ready for review.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 9,
          durationBd: 3,
          showDeadline: true,
        },
        {
          name: 'V1 — client review',
          description: 'Feedback due so the script locks and is sent for voice-over recording.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 11,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'Script locked → VO artist',
          description: 'VO artist prepares and submits recording.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 12,
          durationBd: 2,
        },
        {
          name: 'Edit — V2',
          description: 'Incorporates feedback from the V1 review.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 13,
          durationBd: 3,
          showDeadline: true,
        },
        {
          name: 'V2 — client review',
          description: 'Fast turnaround to hold the schedule.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 15,
          durationBd: 1,
          showDeadline: true,
        },
        {
          name: 'Edit — V3 + social media cuts',
          description: 'Main video plus social media cut-downs.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 15,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'V3 — client review',
          description: 'Final round of client feedback before sign-off.',
          kind: 'BAR',
          owner: 'CLIENT',
          startBd: 16,
          durationBd: 3,
          showDeadline: true,
        },
      ],
    },
    {
      name: 'Delivery & sign-off',
      color: '#2478CC',
      tasks: [
        {
          name: 'Supply final versions',
          description: 'Deliver signed-off final versions of all cuts.',
          kind: 'BAR',
          owner: 'STUDIO',
          startBd: 18,
          durationBd: 2,
          showDeadline: true,
        },
        {
          name: 'Final presentation',
          description: 'Present the delivered final versions.',
          kind: 'MILESTONE',
          owner: 'STUDIO',
          startBd: 19,
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
