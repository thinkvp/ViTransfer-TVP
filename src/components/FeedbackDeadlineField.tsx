'use client'

import { Input } from './ui/input'
import { Label } from './ui/label'
import { addDaysYmd, describeFeedbackDeadline, isValidFeedbackDueDate, todayYmd } from '@/lib/feedback-deadline'

const QUICK_PICKS: Array<{ label: string; days: number }> = [
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
  { label: '+2 weeks', days: 14 },
]

/**
 * Optional client feedback deadline (date only) for a video version. Used by the
 * upload forms; `value` is '' for "no deadline".
 */
export function FeedbackDeadlineField({
  id,
  value,
  onChange,
  disabled,
  label = 'Feedback Deadline',
}: {
  id: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  label?: string
}) {
  const today = todayYmd()
  const hint = value && isValidFeedbackDueDate(value) ? describeFeedbackDeadline(value, today) : 'No deadline'

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} <span className="text-muted-foreground font-normal">(Optional)</span>
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="date"
          value={value}
          min={today}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-auto"
        />
        {QUICK_PICKS.map((p) => (
          <button
            key={p.days}
            type="button"
            disabled={disabled}
            onClick={() => onChange(addDaysYmd(today, p.days) || '')}
            className="h-8 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
        {value ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange('')}
            className="h-8 px-1 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Clear
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {hint}. Shown to the client on the share page and in notification emails.
      </p>
    </div>
  )
}
