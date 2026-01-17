'use client'

import { Bell, BellOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function SalesRemindersBellButton(props: {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  className?: string
}) {
  const enabled = Boolean(props.enabled)

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={props.disabled}
      onClick={props.onToggle}
      aria-pressed={enabled}
      title={enabled ? 'Sales reminders enabled' : 'Sales reminders disabled'}
      aria-label={enabled ? 'Sales reminders enabled' : 'Sales reminders disabled'}
      className={cn(props.className)}
    >
      {enabled ? (
        <Bell className="h-4 w-4 text-green-600" />
      ) : (
        <BellOff className="h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  )
}
