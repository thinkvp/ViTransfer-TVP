'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Mail, Plus, Star, Trash2, Bell, BellOff } from 'lucide-react'

export interface EditableRecipient {
  id?: string
  email: string | null
  name: string | null
  isPrimary: boolean
  receiveNotifications: boolean
}

interface RecipientsEditorProps {
  label?: string
  description?: string
  value: EditableRecipient[]
  onChange: (next: EditableRecipient[]) => void
  addButtonLabel?: string
}

function normalizeEmail(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase()
}

export function RecipientsEditor({
  label = 'Recipients',
  description = 'Manage who receives notifications and updates',
  value,
  onChange,
  addButtonLabel = 'Add Recipient',
}: RecipientsEditorProps) {
  const recipients = useMemo(() => value || [], [value])
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')

  useEffect(() => {
    // Ensure at most one primary
    const primaryCount = recipients.filter((r) => r.isPrimary).length
    if (recipients.length > 0 && primaryCount !== 1) {
      const next = recipients.map((r, idx) => ({ ...r, isPrimary: idx === 0 }))
      onChange(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addRecipient = () => {
    const name = newName.trim()
    const email = newEmail.trim()

    if (!name && !email) {
      alert('Please enter at least a name or email address')
      return
    }

    if (email && !email.includes('@')) {
      alert('Please enter a valid email address')
      return
    }

    const emailKey = normalizeEmail(email)
    if (emailKey && recipients.some((r) => normalizeEmail(r.email) === emailKey)) {
      alert('That email is already in the list')
      return
    }

    const next: EditableRecipient[] = [
      ...recipients,
      {
        name: name || null,
        email: email || null,
        isPrimary: recipients.length === 0,
        receiveNotifications: true,
      },
    ]

    onChange(next)
    setNewName('')
    setNewEmail('')
    setShowAddForm(false)
  }

  const removeRecipient = (idx: number) => {
    const next = recipients.filter((_, i) => i !== idx)
    if (next.length > 0 && !next.some((r) => r.isPrimary)) {
      next[0] = { ...next[0], isPrimary: true }
    }
    onChange(next)
  }

  const setPrimary = (idx: number) => {
    const next = recipients.map((r, i) => ({ ...r, isPrimary: i === idx }))
    onChange(next)
  }

  const toggleNotifications = (idx: number) => {
    const next = recipients.map((r, i) => (i === idx ? { ...r, receiveNotifications: !r.receiveNotifications } : r))
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label>{label}</Label>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </div>
        <Button type="button" variant="default" size="sm" onClick={() => setShowAddForm(true)} disabled={showAddForm}>
          <Plus className="w-4 h-4 sm:mr-2" />
          <span className="hidden sm:inline">{addButtonLabel}</span>
        </Button>
      </div>

      {recipients.length === 0 && !showAddForm ? (
        <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
          No recipients added yet. Click &quot;{addButtonLabel}&quot; to add one.
        </div>
      ) : (
        <div className="space-y-2">
          {recipients.map((recipient, idx) => (
            <div key={`${normalizeEmail(recipient.email)}:${idx}`} className="border rounded-lg bg-card">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
                <div className="flex-1 space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {recipient.name || recipient.email || 'No contact info'}
                    </span>
                    {recipient.isPrimary && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                        Primary
                      </span>
                    )}
                  </div>
                  {(recipient.name || recipient.email) && (
                    <div className="text-xs text-muted-foreground truncate">
                      {recipient.name && recipient.email ? `${recipient.name} • ${recipient.email}` : recipient.email || recipient.name}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPrimary(idx)} title="Set as primary">
                    <Star className={recipient.isPrimary ? 'w-4 h-4 text-primary' : 'w-4 h-4'} />
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => toggleNotifications(idx)} title="Toggle notifications">
                    {recipient.receiveNotifications ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => removeRecipient(idx)} title="Remove">
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddForm && (
        <div className="border rounded-lg bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-recipient-name">Client Name (Optional)</Label>
              <Input
                id="new-recipient-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-recipient-email">Client Email (Optional)</Label>
              <Input
                id="new-recipient-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="e.g., client@example.com"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={addRecipient}>
              <Plus className="w-4 h-4 mr-2" />
              Add
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
