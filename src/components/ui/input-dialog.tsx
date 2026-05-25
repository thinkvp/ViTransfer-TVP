'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface InputDialogProps {
  open: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: (value: string) => void | Promise<void>
  onCancel?: () => void
  loading?: boolean
}

export function InputDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder,
  defaultValue = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  loading = false,
}: InputDialogProps) {
  const [value, setValue] = React.useState(defaultValue)
  const [busy, setBusy] = React.useState(false)
  const isLoading = loading || busy
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Reset value when dialog opens or defaultValue changes
  React.useEffect(() => {
    if (open) {
      setValue(defaultValue)
      // Focus the input after the animation settles
      const t = setTimeout(() => inputRef.current?.select(), 80)
      return () => clearTimeout(t)
    }
  }, [open, defaultValue])

  const handleConfirm = async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      inputRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      await onConfirm(trimmed)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = () => {
    if (isLoading) return
    onCancel?.()
    onOpenChange?.(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isLoading) handleCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-1">
          {label && <Label htmlFor="input-dialog-field">{label}</Label>}
          <Input
            id="input-dialog-field"
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            {cancelLabel}
          </Button>
          <Button onClick={handleConfirm} disabled={isLoading || !value.trim()}>
            {isLoading ? 'Please wait…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
