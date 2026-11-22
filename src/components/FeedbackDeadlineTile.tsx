'use client'

import { cn } from '@/lib/utils'
import { formatFeedbackDueDate, getFeedbackDeadlineStatus, parseFeedbackDueDate, todayYmd } from '@/lib/feedback-deadline'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Feedback deadline as a calendar tile + sentence (share-page comment panel).
 * Tone follows urgency: neutral while there's time, amber the day before and on the
 * day, red once overdue. `instruction` is the "what to do" line under the title —
 * the caller knows which actions (approve / request next version) are on offer.
 */
export function FeedbackDeadlineTile({
  dueYmd,
  extended = false,
  audience = 'client',
  instruction,
  className,
}: {
  dueYmd: string
  extended?: boolean
  audience?: 'client' | 'admin'
  instruction?: string | null
  className?: string
}) {
  const date = parseFeedbackDueDate(dueYmd)
  const state = getFeedbackDeadlineStatus(dueYmd, todayYmd())
  if (!date || !state) return null

  const { status, daysLeft } = state
  const tone = status === 'overdue' ? 'danger' : daysLeft <= 1 ? 'warning' : 'neutral'
  // Within the coming/past week a weekday reads naturally ("due Thursday"); further out, the date.
  const when = Math.abs(daysLeft) <= 6 ? WEEKDAYS_LONG[date.getDay()] : formatFeedbackDueDate(dueYmd)
  const subject = audience === 'admin' ? 'Client feedback' : 'Your feedback'

  const title =
    status === 'overdue'
      ? `${audience === 'admin' ? 'Client feedback' : 'Feedback'} was due ${when}`
      : status === 'today'
      ? `${subject} is due today`
      : daysLeft === 1
      ? `${subject} is due tomorrow`
      : `${subject} is due ${when}`

  const countdown =
    status === 'overdue'
      ? `${-daysLeft} ${daysLeft === -1 ? 'day' : 'days'} overdue.`
      : status === 'today'
      ? 'Today is the last day.'
      : daysLeft === 1
      ? '1 day left.'
      : `${daysLeft} days left.`

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        className={cn(
          'w-12 shrink-0 overflow-hidden rounded-lg border bg-background text-center',
          tone === 'danger' ? 'border-destructive/50' : tone === 'warning' ? 'border-warning/50' : 'border-border'
        )}
        aria-hidden="true"
      >
        <div
          className={cn(
            'py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            tone === 'danger'
              ? 'bg-destructive/15 text-destructive'
              : tone === 'warning'
              ? 'bg-warning/15 text-warning'
              : 'bg-primary/15 text-primary'
          )}
        >
          {MONTHS[date.getMonth()]}
        </div>
        <div className="text-lg font-semibold leading-tight text-foreground">{date.getDate()}</div>
        <div className="pb-0.5 text-[10px] text-muted-foreground">{WEEKDAYS_SHORT[date.getDay()]}</div>
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-foreground">
          <span>{title}</span>
          {extended ? (
            <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              Extended
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <span
            className={cn(
              tone === 'danger' && 'font-medium text-destructive',
              tone === 'warning' && 'font-medium text-warning'
            )}
          >
            {countdown}
          </span>
          {instruction ? ` ${instruction}` : ''}
        </p>
        <span className="sr-only">Due {formatFeedbackDueDate(dueYmd, { withYear: true })}</span>
      </div>
    </div>
  )
}
