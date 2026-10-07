'use client'

import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { registerLodgedPeriodConfirmHandler } from '@/lib/lodged-period-confirm'

/**
 * Shows the "this changes a lodged BAS" confirmation for any admin write (apiFetch asks
 * through lodged-period-confirm.ts). Mounted once in the admin layout.
 */
export function LodgedPeriodConfirmHost() {
  const [message, setMessage] = useState<string | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => registerLodgedPeriodConfirmHandler((next) => new Promise<boolean>((resolve) => {
    // A second request while one is open: decline the older one rather than stack dialogs.
    resolveRef.current?.(false)
    resolveRef.current = resolve
    setMessage(next)
  })), [])

  function settle(ok: boolean) {
    const resolve = resolveRef.current
    resolveRef.current = null
    setMessage(null)
    resolve?.(ok)
  }

  return (
    <ConfirmDialog
      open={message !== null}
      onOpenChange={(open) => { if (!open) settle(false) }}
      title="Change a lodged BAS?"
      description={message ?? ''}
      confirmLabel="Make the change"
      variant="default"
      onConfirm={() => settle(true)}
    />
  )
}
