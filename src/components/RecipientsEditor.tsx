'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Plus, Star, Trash2, Bell, BellOff, Pencil, Check, X, DollarSign } from 'lucide-react'
import type { ButtonProps } from '@/components/ui/button'
import { generateRandomHexDisplayColor, normalizeHexDisplayColor } from '@/lib/display-color'
import { InitialsAvatar } from '@/components/InitialsAvatar'

export interface EditableRecipient {
  id?: string
  email: string | null
  name: string | null
  displayColor?: string | null
  alsoAddToClient?: boolean
  isPrimary: boolean
  receiveNotifications: boolean
  receiveSalesReminders?: boolean
}

export interface ClientRecipientPickItem {
  id?: string
  email: string | null
  name: string | null
  displayColor?: string | null
}

interface RecipientsEditorProps {
  label?: string
  description?: string
  value: EditableRecipient[]
  onChange: (next: EditableRecipient[]) => void
  addButtonLabel?: string
  addButtonVariant?: ButtonProps['variant']
  addButtonSize?: ButtonProps['size']
  addButtonHideLabelOnMobile?: boolean
  addButtonFixedWidth?: boolean
  emptyStateText?: string
  showNotificationsToggle?: boolean
  showSalesRemindersToggle?: boolean
  showDisplayColor?: boolean
  showAlsoAddToClient?: boolean
  addMode?: 'inline' | 'dialog'
  clientRecipients?: ClientRecipientPickItem[]
  clientName?: string
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
  addButtonVariant = 'default',
  addButtonSize = 'sm',
  addButtonHideLabelOnMobile = true,
  addButtonFixedWidth = true,
  emptyStateText,
  showNotificationsToggle = true,
  showSalesRemindersToggle = false,
  showDisplayColor = true,
  showAlsoAddToClient = false,
  addMode = 'inline',
  clientRecipients,
  clientName,
}: RecipientsEditorProps) {
  const recipients = useMemo(() => value || [], [value])
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newDisplayColor, setNewDisplayColor] = useState(() => generateRandomHexDisplayColor())
  const [newAlsoAddToClient, setNewAlsoAddToClient] = useState(false)

  const [clientSelection, setClientSelection] = useState<Record<string, boolean>>({})

  const actionButtonClassName = 'h-9 w-9 p-0'

  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editDisplayColor, setEditDisplayColor] = useState<string>('')

  useEffect(() => {
    // Ensure at most one primary
    const primaryCount = recipients.filter((r) => r.isPrimary).length
    if (recipients.length > 0 && primaryCount !== 1) {
      const next = recipients.map((r, idx) => ({ ...r, isPrimary: idx === 0 }))
      onChange(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function keyForRecipient(r: { email: string | null; name: string | null }): string {
    const emailKey = normalizeEmail(r.email)
    if (emailKey) return `e:${emailKey}`
    const nameKey = (r.name || '').trim().toLowerCase()
    if (nameKey) return `n:${nameKey}`
    return ''
  }

  function ensureSinglePrimary(next: EditableRecipient[]): EditableRecipient[] {
    if (next.length === 0) return next
    const primaryIdx = next.findIndex((r) => r.isPrimary)
    if (primaryIdx === -1) {
      return next.map((r, idx) => ({ ...r, isPrimary: idx === 0 }))
    }
    // If multiple primaries, keep the first and clear the rest
    let seenPrimary = false
    return next.map((r) => {
      if (!r.isPrimary) return r
      if (!seenPrimary) {
        seenPrimary = true
        return r
      }
      return { ...r, isPrimary: false }
    })
  }

  const clientRecipientItems = useMemo(() => {
    const list = Array.isArray(clientRecipients) ? clientRecipients : []
    return list
      .map((r, idx) => {
        const key = keyForRecipient({ email: r.email, name: r.name })
        return {
          key,
          idx,
          recipient: r,
          label: (r.name || r.email || '').trim(),
        }
      })
      .filter((x) => Boolean(x.key))
  }, [clientRecipients])

  const clientRecipientKeySet = useMemo(() => {
    return new Set(clientRecipientItems.map((x) => x.key))
  }, [clientRecipientItems])

  const showClientInfo = Boolean(showAlsoAddToClient && (clientName || clientRecipientItems.length > 0))

  useEffect(() => {
    if (addMode !== 'dialog') return
    if (!showAddForm) return

    const projectRecipientKeys = new Set(recipients.map((r) => keyForRecipient({ email: r.email, name: r.name })).filter(Boolean))
    const initial: Record<string, boolean> = {}
    for (const item of clientRecipientItems) {
      initial[item.key] = projectRecipientKeys.has(item.key)
    }
    setClientSelection(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMode, showAddForm])

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
        displayColor: showDisplayColor ? (normalizeHexDisplayColor(newDisplayColor) || newDisplayColor || generateRandomHexDisplayColor()) : null,
        ...(showAlsoAddToClient ? { alsoAddToClient: newAlsoAddToClient } : {}),
        isPrimary: recipients.length === 0,
        receiveNotifications: true,
      },
    ]

    onChange(next)
    setNewName('')
    setNewEmail('')
    setNewDisplayColor(generateRandomHexDisplayColor())
    setNewAlsoAddToClient(false)
    setShowAddForm(false)
  }

  const cancelAdd = () => {
    setShowAddForm(false)
    setNewAlsoAddToClient(false)
  }

  const saveClientSelection = () => {
    const clientKeySet = new Set(clientRecipientItems.map((x) => x.key))

    const next: EditableRecipient[] = []
    const keptClientKeys = new Set<string>()

    // Preserve existing order: keep all non-client recipients as-is;
    // for client recipients, keep/remove based on selection.
    for (const r of recipients) {
      const k = keyForRecipient({ email: r.email, name: r.name })
      if (k && clientKeySet.has(k)) {
        if (clientSelection[k]) {
          next.push(r)
          keptClientKeys.add(k)
        }
        continue
      }
      next.push(r)
    }

    // Add newly-selected client recipients that weren't already in the list.
    for (const item of clientRecipientItems) {
      if (!clientSelection[item.key]) continue
      if (keptClientKeys.has(item.key)) continue

      const displayColor = showDisplayColor
        ? (normalizeHexDisplayColor(item.recipient.displayColor || '') || item.recipient.displayColor || generateRandomHexDisplayColor())
        : null

      next.push({
        name: item.recipient.name ?? null,
        email: item.recipient.email ?? null,
        displayColor,
        isPrimary: false,
        receiveNotifications: true,
      })
    }

    const ensured = ensureSinglePrimary(next)
    onChange(ensured)
    setShowAddForm(false)
  }

  const startEdit = (idx: number) => {
    const r = recipients[idx]
    setEditingIdx(idx)
    setEditName(String(r?.name || ''))
    setEditEmail(String(r?.email || ''))
    setEditDisplayColor(String(r?.displayColor || generateRandomHexDisplayColor()))
  }

  const cancelEdit = () => {
    setEditingIdx(null)
    setEditName('')
    setEditEmail('')
    setEditDisplayColor('')
  }

  const saveEdit = () => {
    if (editingIdx === null) return

    const name = editName.trim()
    const email = editEmail.trim()
    if (!name && !email) {
      alert('Please enter at least a name or email address')
      return
    }
    if (email && !email.includes('@')) {
      alert('Please enter a valid email address')
      return
    }

    const emailKey = normalizeEmail(email)
    if (emailKey && recipients.some((r, i) => i !== editingIdx && normalizeEmail(r.email) === emailKey)) {
      alert('That email is already in the list')
      return
    }

    let nextColor: string | null | undefined = undefined
    if (showDisplayColor) {
      const rawColor = String(editDisplayColor || '').trim()
      if (rawColor) {
        const normalized = normalizeHexDisplayColor(rawColor)
        if (!normalized) {
          alert('Invalid display colour. Use a hex value like #RRGGBB.')
          return
        }
        nextColor = normalized
      } else {
        nextColor = null
      }
    }

    const next = recipients.map((r, i) => {
      if (i !== editingIdx) return r
      return {
        ...r,
        name: name || null,
        email: email || null,
        displayColor: showDisplayColor ? nextColor : (r.displayColor ?? null),
      }
    })

    onChange(next)
    cancelEdit()
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

  const toggleSalesReminders = (idx: number) => {
    const next = recipients.map((r, i) => {
      if (i !== idx) return r
      const current = (r as any)?.receiveSalesReminders
      const enabled = current !== false
      return { ...r, receiveSalesReminders: !enabled }
    })
    onChange(next)
  }

  const resolvedEmptyStateText =
    emptyStateText ?? `No recipients added yet. Click "${addButtonLabel}" to add one.`

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 sm:items-center">
        <div className="min-w-0">
          <Label>{label}</Label>
          {description ? (
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          ) : null}
        </div>
        <div className={addButtonFixedWidth ? 'shrink-0 w-auto md:w-64 flex justify-end' : 'shrink-0 w-auto flex justify-end'}>
          <Button
            type="button"
            variant={addButtonVariant}
            size={addButtonSize}
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
            className={addButtonFixedWidth ? 'w-auto md:w-full' : 'w-auto'}
          >
            <Plus className={addButtonHideLabelOnMobile ? 'w-4 h-4 sm:mr-2' : 'w-4 h-4 mr-2'} />
            <span className={addButtonHideLabelOnMobile ? 'hidden sm:inline' : undefined}>{addButtonLabel}</span>
          </Button>
        </div>
      </div>

      {recipients.length === 0 && !showAddForm ? (
        <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
          {resolvedEmptyStateText}
        </div>
      ) : (
        <div className="space-y-2">
          {recipients.map((recipient, idx) => (
            <div key={`${normalizeEmail(recipient.email)}:${idx}`} className="border rounded-lg bg-card">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
                <div className="flex-1 space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <InitialsAvatar name={recipient.name} email={recipient.email} displayColor={recipient.displayColor} />
                    <span className="text-sm font-medium truncate">
                      {recipient.name || recipient.email || 'No contact info'}
                    </span>
                    {recipient.isPrimary && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                        Primary
                      </span>
                    )}
                  </div>
                  {recipient.name && recipient.email && (
                    <div className="text-xs text-muted-foreground truncate">{recipient.email}</div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2">
                  {showSalesRemindersToggle && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleSalesReminders(idx)}
                      title={recipient.receiveSalesReminders !== false ? 'Sales Reminders Enabled' : 'Sales Reminders Disabled'}
                      aria-label={recipient.receiveSalesReminders !== false ? 'Sales Reminders Enabled' : 'Sales Reminders Disabled'}
                      className={
                        recipient.receiveSalesReminders !== false
                          ? `${actionButtonClassName} text-success hover:text-success hover:bg-success-visible`
                          : `${actionButtonClassName} text-muted-foreground hover:text-muted-foreground`
                      }
                    >
                      <DollarSign className="w-4 h-4" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => (editingIdx === idx ? cancelEdit() : startEdit(idx))}
                    title={editingIdx === idx ? 'Cancel edit' : 'Edit recipient'}
                    aria-label={editingIdx === idx ? 'Cancel edit' : 'Edit recipient'}
                    className={actionButtonClassName}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPrimary(idx)}
                    title="Set as primary"
                    aria-label="Set as primary"
                    className={actionButtonClassName}
                  >
                    <Star className={recipient.isPrimary ? 'w-4 h-4 text-primary' : 'w-4 h-4'} />
                  </Button>
                  {showNotificationsToggle && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleNotifications(idx)}
                      title="Toggle notifications"
                      aria-label="Toggle notifications"
                      className={
                        recipient.receiveNotifications
                          ? `${actionButtonClassName} text-success hover:text-success hover:bg-success-visible`
                          : `${actionButtonClassName} text-muted-foreground hover:text-muted-foreground`
                      }
                    >
                      {recipient.receiveNotifications ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => removeRecipient(idx)}
                    title="Remove"
                    aria-label="Remove"
                    className={actionButtonClassName}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>

              {editingIdx === idx && (
                <div className="border-t border-border p-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor={`edit-recipient-name-${idx}`}>Contact Name</Label>
                      <Input
                        id={`edit-recipient-name-${idx}`}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="e.g., Jane Doe"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`edit-recipient-email-${idx}`}>Contact Email</Label>
                      <Input
                        id={`edit-recipient-email-${idx}`}
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        placeholder="e.g., contact@example.com"
                      />
                    </div>
                    {showDisplayColor && (
                      <div className="space-y-1">
                        <Label htmlFor={`edit-recipient-displayColor-${idx}`}>Display Colour</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`edit-recipient-displayColor-${idx}`}
                            type="color"
                            className="w-12 h-10 p-1"
                            value={editDisplayColor || '#000000'}
                            onChange={(e) => setEditDisplayColor(e.target.value)}
                          />
                          <Input
                            value={editDisplayColor}
                            onChange={(e) => setEditDisplayColor(e.target.value)}
                            placeholder="#RRGGBB"
                            maxLength={7}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setEditDisplayColor(generateRandomHexDisplayColor())}
                            title="Random colour"
                          >
                            <Plus className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {showDisplayColor && showClientInfo && (
                      <div className="space-y-1">
                        <Label>Client</Label>
                        <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                          {(() => {
                            const recipientKey = keyForRecipient({ email: recipient.email, name: recipient.name })
                            const assigned = Boolean(recipientKey && clientRecipientKeySet.has(recipientKey))
                            if (!assigned) return 'None'
                            return (clientName || 'Client').trim() || 'Client'
                          })()}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <Button type="button" size="sm" onClick={saveEdit}>
                      <Check className="w-4 h-4 mr-2" />
                      Save
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
                      <X className="w-4 h-4 mr-2" />
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAddForm && addMode === 'dialog' ? (
        <Dialog
          open={showAddForm}
          onOpenChange={(open) => {
            setShowAddForm(open)
            if (!open) setNewAlsoAddToClient(false)
          }}
        >
          <DialogContent className="bg-background dark:bg-card border-border text-foreground dark:text-card-foreground max-w-[95vw] sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{addButtonLabel}</DialogTitle>
            </DialogHeader>

            {clientRecipientItems.length > 0 && (
              <div className="space-y-3">
                <div className="space-y-2">
                  {clientRecipientItems.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="w-full flex items-center gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-muted/40"
                      onClick={() => setClientSelection((prev) => ({ ...prev, [item.key]: !prev[item.key] }))}
                    >
                      <Checkbox checked={Boolean(clientSelection[item.key])} />
                      <InitialsAvatar
                        name={item.recipient.name}
                        email={item.recipient.email}
                        displayColor={item.recipient.displayColor}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{item.recipient.name || item.recipient.email || 'Unnamed recipient'}</div>
                        {item.recipient.name && item.recipient.email && (
                          <div className="text-xs text-muted-foreground truncate">{item.recipient.email}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={saveClientSelection}>
                    Save
                  </Button>
                </div>
              </div>
            )}

            <div className="border-t border-border pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="new-recipient-name">Contact Name</Label>
                  <Input
                    id="new-recipient-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g., Jane Doe"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-recipient-email">Contact Email</Label>
                  <Input
                    id="new-recipient-email"
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="e.g., contact@example.com"
                  />
                </div>
                {showDisplayColor && (
                  <div className="space-y-2">
                    <Label htmlFor="new-recipient-displayColor">Display Colour</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="new-recipient-displayColor"
                        type="color"
                        className="w-12 h-10 p-1"
                        value={newDisplayColor}
                        onChange={(e) => setNewDisplayColor(e.target.value)}
                      />
                      <Input
                        value={newDisplayColor}
                        onChange={(e) => setNewDisplayColor(e.target.value)}
                        placeholder="#RRGGBB"
                        maxLength={7}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setNewDisplayColor(generateRandomHexDisplayColor())}
                        title="Random colour"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}

                {showAlsoAddToClient && (
                  <div className="space-y-2">
                    <Label>Also add to Client?</Label>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                      <p className="text-sm text-muted-foreground">Add to Client</p>
                      <Switch
                        checked={newAlsoAddToClient}
                        onCheckedChange={setNewAlsoAddToClient}
                        aria-label="Also add to Client"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 flex gap-2">
                <Button type="button" size="sm" onClick={addRecipient}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={cancelAdd}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : showAddForm ? (
        <div className="border rounded-lg bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-recipient-name">Contact Name</Label>
              <Input
                id="new-recipient-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-recipient-email">Contact Email</Label>
              <Input
                id="new-recipient-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="e.g., contact@example.com"
              />
            </div>
            {showDisplayColor && (
              <div className="space-y-2">
                <Label htmlFor="new-recipient-displayColor">Display Colour</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="new-recipient-displayColor"
                    type="color"
                    className="w-12 h-10 p-1"
                    value={newDisplayColor}
                    onChange={(e) => setNewDisplayColor(e.target.value)}
                  />
                  <Input
                    value={newDisplayColor}
                    onChange={(e) => setNewDisplayColor(e.target.value)}
                    placeholder="#RRGGBB"
                    maxLength={7}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setNewDisplayColor(generateRandomHexDisplayColor())}
                    title="Random colour"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {showAlsoAddToClient && (
              <div className="space-y-2">
                <Label>Also add to Client?</Label>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <p className="text-sm text-muted-foreground">Add to Client</p>
                  <Switch
                    checked={newAlsoAddToClient}
                    onCheckedChange={setNewAlsoAddToClient}
                    aria-label="Also add to Client"
                  />
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={addRecipient}>
              <Plus className="w-4 h-4 mr-2" />
              Add
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={cancelAdd}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
