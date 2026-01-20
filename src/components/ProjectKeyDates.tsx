'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Bell, Check, Pencil, Plus, Trash2, X } from 'lucide-react'

export type ProjectKeyDateType = 'PRE_PRODUCTION' | 'SHOOTING' | 'DUE_DATE' | 'OTHER'

export type ProjectKeyDate = {
  id: string
  projectId: string
  date: string
  allDay: boolean
  startTime: string | null
  finishTime: string | null
  type: ProjectKeyDateType
  notes: string | null
  reminderAt: string | null
  reminderTargets: any | null
  reminderSentAt?: string | null
  createdAt: string
  updatedAt: string
}

const typeOptions: Array<{ value: ProjectKeyDateType; label: string }> = [
  { value: 'PRE_PRODUCTION', label: 'Pre-production' },
  { value: 'SHOOTING', label: 'Shooting' },
  { value: 'DUE_DATE', label: 'Due date' },
  { value: 'OTHER', label: 'Other' },
]

function formatTypeLabel(type: ProjectKeyDateType): string {
  return typeOptions.find((o) => o.value === type)?.label || type
}

function truncateNotes(notes: string | null | undefined, maxChars = 120): string {
  if (!notes) return ''
  const chars = Array.from(notes)
  if (chars.length <= maxChars) return notes
  return `${chars.slice(0, maxChars).join('').trimEnd()}...`
}

type Draft = {
  id: string | null
  date: string
  allDay: boolean
  startTime: string
  finishTime: string
  type: ProjectKeyDateType
  notes: string
  reminderDate: string
  reminderTime: string
  reminderUserIds: string[]
  reminderRecipientIds: string[]
}

type ReminderOptions = {
  users: Array<{ id: string; name: string; email: string }>
  recipients: Array<{ id: string; name: string; email: string }>
}

function splitIsoToLocalDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }

  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return { date: `${y}-${m}-${day}`, time: `${hh}:${mm}` }
}

function toIsoFromLocalDateTime(date: string, time: string): string | null {
  if (!date.trim() || !time.trim()) return null
  const [y, m, d] = date.split('-').map((n) => Number(n))
  const [hh, mm] = time.split(':').map((n) => Number(n))
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0)
  if (isNaN(dt.getTime())) return null
  return dt.toISOString()
}

function PickerOnlyInput({
  value,
  onChange,
  type,
  disabled,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  type: 'date' | 'time'
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  const tryShowPicker = (el: HTMLInputElement) => {
    const anyEl = el as any
    if (typeof anyEl.showPicker === 'function') {
      try {
        anyEl.showPicker()
      } catch {
        // ignore
      }
    }
  }

  return (
    <Input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      inputMode="none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          tryShowPicker(e.currentTarget)
          e.preventDefault()
          return
        }
        // Allow navigation keys, block typing/paste.
        if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Escape') return
        if (e.ctrlKey || e.metaKey) {
          if (e.key.toLowerCase() === 'a' || e.key.toLowerCase() === 'c') return
          e.preventDefault()
          return
        }
        if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
        }
      }}
      onPaste={(e) => e.preventDefault()}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={(e) => {
        // Radix Dialog will autofocus the first field on open; don't open pickers on programmatic focus.
        // Only open on an explicit pointer interaction.
        tryShowPicker(e.currentTarget)
      }}
      className={`no-picker-icon ${className || ''}`}
    />
  )
}

function isValidTime24h(value: string): boolean {
  const v = value.trim()
  if (!v) return true
  const m = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(v)
  return Boolean(m)
}

function TimeInput24h({
  value,
  onChange,
  disabled,
  className,
  placeholder,
  listId,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
  listId: string
}) {
  return (
    <>
      <Input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder || 'HH:MM'}
        inputMode="numeric"
        pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
        list={listId}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      />
      <datalist id={listId}>
        {Array.from({ length: 24 * 4 }).map((_, i) => {
          const minutes = i * 15
          const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
          const mm = String(minutes % 60).padStart(2, '0')
          const t = `${hh}:${mm}`
          return <option key={t} value={t} />
        })}
      </datalist>
    </>
  )
}

function toDraft(item: ProjectKeyDate): Draft {
  const targets = (item.reminderTargets || null) as any
  const userIds = Array.isArray(targets?.userIds) ? targets.userIds.map(String) : []
  const recipientIds = Array.isArray(targets?.recipientIds) ? targets.recipientIds.map(String) : []
  const reminder = splitIsoToLocalDateTime(item.reminderAt)

  return {
    id: item.id,
    date: item.date,
    allDay: item.allDay,
    startTime: item.startTime || '',
    finishTime: item.finishTime || '',
    type: item.type,
    notes: item.notes || '',
    reminderDate: reminder.date,
    reminderTime: reminder.time,
    reminderUserIds: userIds,
    reminderRecipientIds: recipientIds,
  }
}

function createEmptyDraft(): Draft {
  return {
    id: null,
    date: '',
    allDay: false,
    startTime: '',
    finishTime: '',
    type: 'SHOOTING',
    notes: '',
    reminderDate: '',
    reminderTime: '',
    reminderUserIds: [],
    reminderRecipientIds: [],
  }
}

export function ProjectKeyDates({
  projectId,
  canEdit,
  initialEditKeyDateId,
}: {
  projectId: string
  canEdit: boolean
  initialEditKeyDateId?: string | null
}) {
  const [items, setItems] = useState<ProjectKeyDate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [hasAutoOpened, setHasAutoOpened] = useState(false)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [reminderOptions, setReminderOptions] = useState<ReminderOptions | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const data = await apiJson<{ keyDates?: ProjectKeyDate[] }>(`/api/projects/${projectId}/key-dates`)
      setItems(Array.isArray(data?.keyDates) ? (data.keyDates as ProjectKeyDate[]) : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load key dates')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!dialogOpen) return
    if (reminderOptions) return
    const loadOptions = async () => {
      try {
        const data = await apiJson<ReminderOptions>(`/api/projects/${projectId}/key-dates/reminder-options`)
        setReminderOptions({
          users: Array.isArray(data?.users) ? data.users : [],
          recipients: Array.isArray(data?.recipients) ? data.recipients : [],
        })
      } catch {
        setReminderOptions({ users: [], recipients: [] })
      }
    }
    void loadOptions()
  }, [dialogOpen, projectId, reminderOptions])

  const sorted = useMemo(() => {
    const next = [...items]
    next.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date)
      const aStart = a.startTime || ''
      const bStart = b.startTime || ''
      if (aStart !== bStart) return aStart.localeCompare(bStart)
      return a.id.localeCompare(b.id)
    })
    return next
  }, [items])

  const startAdd = () => {
    if (!canEdit) return
    setError(null)
    setDialogError(null)
    setDraft(createEmptyDraft())
    setDialogOpen(true)
  }

  const startEdit = (item: ProjectKeyDate) => {
    if (!canEdit) return
    setError(null)
    setDialogError(null)
    setDraft(toDraft(item))
    setDialogOpen(true)
  }

  useEffect(() => {
    if (!canEdit) return
    const id = typeof initialEditKeyDateId === 'string' ? initialEditKeyDateId.trim() : ''
    if (!id) return
    if (hasAutoOpened) return
    if (dialogOpen) return
    if (loading) return

    const found = items.find((x) => x.id === id)
    if (!found) {
      setHasAutoOpened(true)
      return
    }

    setHasAutoOpened(true)
    startEdit(found)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, dialogOpen, hasAutoOpened, initialEditKeyDateId, items, loading])

  const cancelDraft = () => {
    setDraft(null)
    setDialogOpen(false)
    setDialogError(null)
  }

  const saveDraft = async () => {
    if (!draft) return
    setError(null)
    setDialogError(null)

    if (!draft.date.trim()) {
      setDialogError('Date is required')
      return
    }

    if (!draft.allDay) {
      if (!isValidTime24h(draft.startTime)) {
        setDialogError('Start time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
        return
      }
      if (!isValidTime24h(draft.finishTime)) {
        setDialogError('Finish time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
        return
      }
    }

    if (!isValidTime24h(draft.reminderTime)) {
      setDialogError('Reminder time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
      return
    }

    const reminderAnyTargets =
      (draft.reminderUserIds?.length || 0) + (draft.reminderRecipientIds?.length || 0) > 0
    const reminderAnyDateTime = Boolean(draft.reminderDate?.trim()) || Boolean(draft.reminderTime?.trim())
    const reminderAnyFields = reminderAnyTargets || reminderAnyDateTime

    if (reminderAnyFields) {
      if (!draft.reminderDate?.trim() || !draft.reminderTime?.trim()) {
        setDialogError('Reminder date and time are required')
        return
      }
      if (!reminderAnyTargets) {
        setDialogError('Select at least one user or recipient for the reminder')
        return
      }
    }

    try {
      const reminderAt = toIsoFromLocalDateTime(draft.reminderDate, draft.reminderTime)

      if (reminderAnyFields) {
        if (!reminderAt) {
          setDialogError('Reminder date and time are required')
          return
        }
        const reminderAtMs = new Date(reminderAt).getTime()
        if (!Number.isFinite(reminderAtMs) || reminderAtMs <= Date.now()) {
          setDialogError('Reminder must be set to a future date and time')
          return
        }
      }

      const reminderTargets = {
        userIds: draft.reminderUserIds,
        recipientIds: draft.reminderRecipientIds,
      }

      const payload = {
        date: draft.date,
        allDay: draft.allDay,
        startTime: draft.allDay ? '' : draft.startTime,
        finishTime: draft.allDay ? '' : draft.finishTime,
        type: draft.type,
        notes: draft.notes,
        reminderAt: reminderAt || '',
        reminderTargets,
      }

      if (!draft.id) {
        await apiPost(`/api/projects/${projectId}/key-dates`, payload)
      } else {
        await apiPatch(`/api/projects/${projectId}/key-dates/${draft.id}`, payload)
      }

      setDraft(null)
      setDialogOpen(false)
      setDialogError(null)
      await refresh()
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : 'Failed to save key date')
    }
  }

  const deleteItem = async (id: string) => {
    if (!canEdit) return
    if (!confirm('Delete this key date?')) return

    setError(null)
    try {
      await apiDelete(`/api/projects/${projectId}/key-dates/${id}`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete key date')
    }
  }

  const toggleId = (arr: string[], id: string) => {
    if (arr.includes(id)) return arr.filter((x) => x !== id)
    return [...arr, id]
  }

  return (
    <div className="border rounded-lg p-4 bg-card space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-base font-medium">Key Dates</div>
        </div>
        {canEdit && (
          <div className="w-full sm:w-64">
            <Button type="button" variant="outline" onClick={startAdd} className="w-full" disabled={Boolean(draft)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Date
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground py-4 text-center">Loading key dates…</div>
      ) : sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
          No key dates added yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 whitespace-nowrap">Date</th>
                <th className="px-3 py-2 whitespace-nowrap">All day</th>
                <th className="px-3 py-2 whitespace-nowrap">Start</th>
                <th className="px-3 py-2 whitespace-nowrap">Finish</th>
                <th className="px-3 py-2 whitespace-nowrap">Type</th>
                <th className="px-3 py-2 min-w-[120px]">Notes</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => {
                return (
                  <tr key={item.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span>{item.date}</span>
                        {item.reminderAt ? <Bell className="w-4 h-4 text-muted-foreground" /> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">{item.allDay ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{item.allDay ? '-' : (item.startTime || '-')}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{item.allDay ? '-' : (item.finishTime || '-')}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatTypeLabel(item.type)}</td>
                    <td className="px-3 py-2 min-w-[120px] whitespace-normal break-words">
                      <span title={item.notes || ''}>{truncateNotes(item.notes, 120)}</span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canEdit ? (
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => startEdit(item)}
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void deleteItem(item.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            setDraft(null)
            setDialogError(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Edit Key Date' : 'Add Key Date'}</DialogTitle>
          </DialogHeader>

          {dialogError ? (
            <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
              {dialogError}
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto pr-1">
            {draft ? (
              <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium">Date</div>
                <PickerOnlyInput
                  type="date"
                  value={draft.date}
                  onChange={(v) => setDraft((p) => (p ? { ...p, date: v } : p))}
                  className="h-10"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  checked={draft.allDay}
                  onCheckedChange={(v) =>
                    setDraft((p) => (p ? { ...p, allDay: Boolean(v), startTime: '', finishTime: '' } : p))
                  }
                />
                <div className="text-sm">All day</div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <div className="text-sm font-medium">Start</div>
                  <TimeInput24h
                    value={draft.startTime}
                    disabled={draft.allDay}
                    onChange={(v) => setDraft((p) => (p ? { ...p, startTime: v } : p))}
                    className="h-10"
                    listId="project-key-date-start-times"
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">Finish</div>
                  <TimeInput24h
                    value={draft.finishTime}
                    disabled={draft.allDay}
                    onChange={(v) => setDraft((p) => (p ? { ...p, finishTime: v } : p))}
                    className="h-10"
                    listId="project-key-date-finish-times"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Type</div>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft((p) => (p ? { ...p, type: e.target.value as ProjectKeyDateType } : p))}
                  className="w-full px-3 h-10 bg-card border border-border rounded-md"
                >
                  {typeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Notes</div>
                <Textarea
                  value={draft.notes}
                  onChange={(e) => setDraft((p) => (p ? { ...p, notes: e.target.value } : p))}
                  className="min-h-[90px] resize-y whitespace-pre-wrap"
                  placeholder="Notes"
                />
              </div>

              <div className="space-y-3 border-t pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Reminder</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDraft((p) =>
                        p
                          ? {
                              ...p,
                              reminderDate: '',
                              reminderTime: '',
                              reminderUserIds: [],
                              reminderRecipientIds: [],
                            }
                          : p
                      )
                    }
                  >
                    Clear
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <div className="text-sm">Reminder date</div>
                    <PickerOnlyInput
                      type="date"
                      value={draft.reminderDate}
                      onChange={(v) => setDraft((p) => (p ? { ...p, reminderDate: v } : p))}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm">Reminder time</div>
                    <TimeInput24h
                      value={draft.reminderTime}
                      onChange={(v) => setDraft((p) => (p ? { ...p, reminderTime: v } : p))}
                      className="h-10"
                      listId="project-key-date-reminder-times"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Send to users</div>
                    <div className="max-h-40 overflow-auto rounded-md border border-border p-2 space-y-2">
                      {(reminderOptions?.users || []).length === 0 ? (
                        <div className="text-xs text-muted-foreground">No users assigned to this project.</div>
                      ) : (
                        (reminderOptions?.users || []).map((u) => (
                          <label key={u.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={draft.reminderUserIds.includes(u.id)}
                              onChange={() =>
                                setDraft((p) => (p ? { ...p, reminderUserIds: toggleId(p.reminderUserIds, u.id) } : p))
                              }
                            />
                            <span className="truncate">{u.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-medium">Send to recipients</div>
                    <div className="max-h-40 overflow-auto rounded-md border border-border p-2 space-y-2">
                      {(reminderOptions?.recipients || []).length === 0 ? (
                        <div className="text-xs text-muted-foreground">No recipients on this project.</div>
                      ) : (
                        (reminderOptions?.recipients || []).map((r) => (
                          <label key={r.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={draft.reminderRecipientIds.includes(r.id)}
                              onChange={() =>
                                setDraft((p) =>
                                  p
                                    ? { ...p, reminderRecipientIds: toggleId(p.reminderRecipientIds, r.id) }
                                    : p
                                )
                              }
                            />
                            <span className="truncate">{r.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:flex-row sm:justify-end sm:space-x-2">
            <Button type="button" variant="outline" onClick={cancelDraft} className="w-full sm:w-auto">
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveDraft()} disabled={!draft?.date.trim()} className="w-full sm:w-auto">
              <Check className="w-4 h-4 mr-2" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
