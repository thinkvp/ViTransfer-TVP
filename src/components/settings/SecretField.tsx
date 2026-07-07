import * as React from 'react'
import { Check, Trash2, Undo2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'

interface SecretFieldProps {
  id: string
  label: string
  /** The value the admin is typing. Empty means "no change" when a secret is already stored. */
  value: string
  onChange: (value: string) => void
  /** True when a secret is already stored server-side (the value itself is never sent to us). */
  configured: boolean
  /** True when the admin has pressed Remove and the stored secret will be cleared on save. */
  markedForRemoval: boolean
  onToggleRemoval: () => void
  placeholder?: string
  /** Extra guidance rendered under the field (e.g. where the key is used). */
  children?: React.ReactNode
}

/**
 * A write-only secret input. The stored secret is never loaded into the browser, so the field
 * shows only whether one is saved and lets the admin replace or remove it:
 *  - stored + blank  => keep the saved secret (nothing is sent)
 *  - stored + typed  => replace it with the new value
 *  - Remove pressed  => clear it on save
 */
export function SecretField({
  id,
  label,
  value,
  onChange,
  configured,
  markedForRemoval,
  onToggleRemoval,
  placeholder,
  children,
}: SecretFieldProps) {
  const savedPlaceholder = '•••••••••••••• saved — leave blank to keep'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {configured && !markedForRemoval && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
      </div>

      {markedForRemoval ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <span className="text-destructive">Will be removed when you save.</span>
          <button
            type="button"
            onClick={onToggleRemoval}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </button>
        </div>
      ) : (
        <PasswordInput
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? savedPlaceholder : placeholder}
          autoComplete="new-password"
        />
      )}

      {children}

      {configured && !markedForRemoval && (
        <button
          type="button"
          onClick={onToggleRemoval}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5" /> Remove saved key
        </button>
      )}
    </div>
  )
}
