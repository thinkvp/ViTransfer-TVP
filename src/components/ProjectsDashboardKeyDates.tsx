'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Plus, RefreshCw, Trash2, Pencil, Bell } from 'lucide-react'
import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import ShareLink from '@/components/ShareLink'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type ProjectKeyDateRow = {
  id: string
  projectId: string
  date: string // YYYY-MM-DD
  allDay: boolean
  startTime: string | null
  finishTime: string | null
  type: string
  notes: string | null
  project: {
    title: string
    companyName: string | null
  }
}

type PersonalKeyDateRow = {
  id: string
  date: string // YYYY-MM-DD
  allDay: boolean
  startTime: string | null
  finishTime: string | null
  title: string
  notes: string | null
  reminderAt?: string | null
  reminderTargets?: any | null
}

type KeyDatesResponse = {
  today: string // YYYY-MM-DD
  keyDates: ProjectKeyDateRow[]
  personalKeyDates?: PersonalKeyDateRow[]
}

type CalendarItem =
  | ({ kind: 'project' } & ProjectKeyDateRow)
  | ({ kind: 'personal' } & PersonalKeyDateRow)

function parseYmdToDateLocal(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((n) => Number(n))
  return new Date(y, (m || 1) - 1, d || 1)
}

function formatHumanDate(ymd: string): string {
  const dt = parseYmdToDateLocal(ymd)
  return dt.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

function typeLabel(type: string): string {
  return String(type)
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function typeColorClasses(type: string): { pill: string; dot: string } {
  switch (type) {
    case 'PRE_PRODUCTION':
      return {
        pill: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20',
        dot: 'bg-blue-500',
      }
    case 'SHOOTING':
      return {
        pill: 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/20',
        dot: 'bg-amber-500',
      }
    case 'DUE_DATE':
      return {
        pill: 'bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/20',
        dot: 'bg-red-500',
      }
    case 'OTHER':
      return {
        pill: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20',
        dot: 'bg-purple-500',
      }
    default:
      return {
        pill: 'bg-foreground/5 text-foreground/80 border border-foreground/10',
        dot: 'bg-foreground/40',
      }
  }
}

function isValidTime24h(value: string): boolean {
  const v = value.trim()
  if (!v) return true
  return Boolean(/^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(v))
}

function addMonths(date: Date, delta: number): Date {
  const next = new Date(date)
  next.setMonth(next.getMonth() + delta)
  return next
}

function ymdForDateLocal(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export default function ProjectsDashboardKeyDates() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<KeyDatesResponse | null>(null)
  const [showAllUpcoming, setShowAllUpcoming] = useState(false)

  const [personalReminderOptions, setPersonalReminderOptions] = useState<{
    users: Array<{ id: string; name: string; email: string }>
  } | null>(null)

  const ensurePersonalReminderOptions = async (): Promise<{
    users: Array<{ id: string; name: string; email: string }>
  }> => {
    if (personalReminderOptions) return personalReminderOptions
    try {
      const result = await apiJson<{ users?: Array<{ id: string; name: string; email: string }> }>(
        '/api/users/me/key-dates/reminder-options'
      )
      const next = { users: Array.isArray(result?.users) ? result.users : [] }
      setPersonalReminderOptions(next)
      return next
    } catch {
      const next = { users: [] }
      setPersonalReminderOptions(next)
      return next
    }
  }

  const splitIsoToLocalDateTime = (iso: string | null | undefined): { date: string; time: string } => {
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

  const toIsoFromLocalDateTime = (date: string, time: string): string | null => {
    if (!date.trim() || !time.trim()) return null
    const [y, m, d] = date.split('-').map((n) => Number(n))
    const [hh, mm] = time.split(':').map((n) => Number(n))
    const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0)
    if (isNaN(dt.getTime())) return null
    return dt.toISOString()
  }

  const toggleId = (arr: string[], id: string) => {
    if (arr.includes(id)) return arr.filter((x) => x !== id)
    return [...arr, id]
  }

  const [personalOpen, setPersonalOpen] = useState(false)
  const [personalSaving, setPersonalSaving] = useState(false)
  const [personalError, setPersonalError] = useState<string | null>(null)
  const [personalDraft, setPersonalDraft] = useState<{
    id: string | null
    date: string
    allDay: boolean
    startTime: string
    finishTime: string
    title: string
    notes: string
    reminderDate: string
    reminderTime: string
    reminderUserIds: string[]
  }>({
    id: null,
    date: '',
    allDay: false,
    startTime: '',
    finishTime: '',
    title: '',
    notes: '',
    reminderDate: '',
    reminderTime: '',
    reminderUserIds: [],
  })

  const [calendarFeedOpen, setCalendarFeedOpen] = useState(false)
  const [calendarFeedUrl, setCalendarFeedUrl] = useState<string | null>(null)
  const [calendarFeedLoading, setCalendarFeedLoading] = useState(false)
  const [calendarFeedError, setCalendarFeedError] = useState<string | null>(null)

  const today = data?.today || ymdForDateLocal(new Date())

  const [monthCursor, setMonthCursor] = useState<Date>(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const result = await apiJson<KeyDatesResponse>('/api/projects/key-dates')
        setData(result)

        // If server's "today" differs from local, align the default month to the server date.
        if (result?.today) {
          const serverToday = parseYmdToDateLocal(result.today)
          setMonthCursor(new Date(serverToday.getFullYear(), serverToday.getMonth(), 1))
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to load key dates')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  const reload = async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await apiJson<KeyDatesResponse>('/api/projects/key-dates')
      setData(result)
    } catch (e: any) {
      setError(e?.message || 'Failed to load key dates')
    } finally {
      setLoading(false)
    }
  }

  const ensureCalendarFeedUrl = async () => {
    if (calendarFeedUrl) return
    try {
      setCalendarFeedLoading(true)
      setCalendarFeedError(null)
      const result = await apiJson<{ url: string }>('/api/users/me/calendar-feed')
      setCalendarFeedUrl(result.url)
    } catch (e: any) {
      setCalendarFeedError(e?.message || 'Failed to load calendar link')
    } finally {
      setCalendarFeedLoading(false)
    }
  }

  const rotateCalendarFeedUrl = async () => {
    try {
      setCalendarFeedLoading(true)
      setCalendarFeedError(null)
      const result = await apiPost<{ url: string }>('/api/users/me/calendar-feed', {})
      setCalendarFeedUrl(result.url)
    } catch (e: any) {
      setCalendarFeedError(e?.message || 'Failed to regenerate calendar link')
    } finally {
      setCalendarFeedLoading(false)
    }
  }

  const upcoming = useMemo(() => {
    const project = (data?.keyDates || []).map((k) => ({ ...k, kind: 'project' as const }))
    const personal = (data?.personalKeyDates || []).map((k) => ({ ...k, kind: 'personal' as const }))
    const all: CalendarItem[] = [...project, ...personal]

    return all
      .filter((k) => k.date >= today)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date)
        const aStart = (a.startTime || '').toString()
        const bStart = (b.startTime || '').toString()
        if (aStart !== bStart) return aStart.localeCompare(bStart)
        return a.id.localeCompare(b.id)
      })
  }, [data?.keyDates, data?.personalKeyDates, today])

  const upcomingVisible = useMemo(() => {
    if (showAllUpcoming) return upcoming
    return upcoming.slice(0, 10)
  }, [showAllUpcoming, upcoming])

  const monthLabel = useMemo(() => {
    return monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }, [monthCursor])

  const monthCells = useMemo(() => {
    const firstOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1)
    const startWeekday = firstOfMonth.getDay() // 0 = Sun
    const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate()

    const cells: Array<{ ymd: string | null; day: number | null }> = []

    for (let i = 0; i < startWeekday; i++) {
      cells.push({ ymd: null, day: null })
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dt = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), day)
      cells.push({ ymd: ymdForDateLocal(dt), day })
    }

    while (cells.length % 7 !== 0) {
      cells.push({ ymd: null, day: null })
    }

    // Keep a consistent grid height (6 rows)
    while (cells.length < 42) {
      cells.push({ ymd: null, day: null })
    }

    return cells
  }, [monthCursor])

  const keyDatesByYmd = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()

    for (const k of data?.keyDates || []) {
      const list = map.get(k.date) || []
      list.push({ ...k, kind: 'project' })
      map.set(k.date, list)
    }

    for (const k of data?.personalKeyDates || []) {
      const list = map.get(k.date) || []
      list.push({ ...k, kind: 'personal' })
      map.set(k.date, list)
    }

    for (const [ymd, list] of map.entries()) {
      list.sort((a, b) => {
        const aStart = (a.startTime || '').toString()
        const bStart = (b.startTime || '').toString()
        if (aStart !== bStart) return aStart.localeCompare(bStart)
        return a.id.localeCompare(b.id)
      })
      map.set(ymd, list)
    }

    return map
  }, [data?.keyDates, data?.personalKeyDates])

  const openPersonalDialog = async () => {
    setPersonalError(null)
    await ensurePersonalReminderOptions()

    setPersonalDraft({
      id: null,
      date: today,
      allDay: false,
      startTime: '',
      finishTime: '',
      title: '',
      notes: '',
      reminderDate: '',
      reminderTime: '',
      reminderUserIds: [],
    })
    setPersonalOpen(true)
  }

  const openEditPersonalDialog = async (row: PersonalKeyDateRow) => {
    setPersonalError(null)
    await ensurePersonalReminderOptions()

    const reminder = splitIsoToLocalDateTime(row.reminderAt)
    const targets = (row.reminderTargets || null) as any
    const userIds = Array.isArray(targets?.userIds) ? targets.userIds.map(String) : []

    setPersonalDraft({
      id: row.id,
      date: row.date,
      allDay: row.allDay,
      startTime: row.startTime || '',
      finishTime: row.finishTime || '',
      title: row.title,
      notes: row.notes || '',
      reminderDate: reminder.date,
      reminderTime: reminder.time,
      reminderUserIds: userIds,
    })
    setPersonalOpen(true)
  }

  const savePersonalKeyDate = async () => {
    setPersonalError(null)

    if (!personalDraft.date.trim()) {
      setPersonalError('Date is required')
      return
    }
    if (!personalDraft.title.trim()) {
      setPersonalError('Title is required')
      return
    }
    if (!personalDraft.allDay) {
      if (!isValidTime24h(personalDraft.startTime)) {
        setPersonalError('Start time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
        return
      }
      if (!isValidTime24h(personalDraft.finishTime)) {
        setPersonalError('Finish time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
        return
      }
    }

    if (!isValidTime24h(personalDraft.reminderTime)) {
      setPersonalError('Reminder time must be 24-hour HH:MM (e.g. 09:30, 18:05)')
      return
    }

    const reminderAnyTargets = (personalDraft.reminderUserIds?.length || 0) > 0
    const reminderAnyDateTime = Boolean(personalDraft.reminderDate?.trim()) || Boolean(personalDraft.reminderTime?.trim())
    const reminderAnyFields = reminderAnyTargets || reminderAnyDateTime

    if (reminderAnyFields) {
      if (!personalDraft.reminderDate?.trim() || !personalDraft.reminderTime?.trim()) {
        setPersonalError('Reminder date and time are required')
        return
      }
      if (!reminderAnyTargets) {
        setPersonalError('Select at least one user for the reminder')
        return
      }
    }

    setPersonalSaving(true)
    try {
      const reminderAt = toIsoFromLocalDateTime(personalDraft.reminderDate, personalDraft.reminderTime)

      if (reminderAnyFields) {
        if (!reminderAt) {
          setPersonalError('Reminder date and time are required')
          return
        }
        const reminderAtMs = new Date(reminderAt).getTime()
        if (!Number.isFinite(reminderAtMs) || reminderAtMs <= Date.now()) {
          setPersonalError('Reminder must be set to a future date and time')
          return
        }
      }

      const payload = {
        date: personalDraft.date,
        allDay: personalDraft.allDay,
        startTime: personalDraft.allDay ? '' : personalDraft.startTime,
        finishTime: personalDraft.allDay ? '' : personalDraft.finishTime,
        title: personalDraft.title,
        notes: personalDraft.notes,
        reminderAt: reminderAt || '',
        reminderTargets: { userIds: personalDraft.reminderUserIds },
      }

      if (personalDraft.id) {
        await apiPatch(`/api/users/me/key-dates/${personalDraft.id}`, payload)
      } else {
        await apiPost('/api/users/me/key-dates', payload)
      }

      setPersonalOpen(false)
      await reload()
    } catch (e: any) {
      setPersonalError(e?.message || 'Failed to save key date')
    } finally {
      setPersonalSaving(false)
    }
  }

  const deletePersonalKeyDate = async (id: string) => {
    if (!confirm('Delete this key date?')) return
    try {
      await apiDelete(`/api/users/me/key-dates/${id}`)
      await reload()
    } catch (e: any) {
      setError(e?.message || 'Failed to delete key date')
    }
  }

  const calendarActions = (
    <>
      <Dialog
        open={calendarFeedOpen}
        onOpenChange={(open) => {
          setCalendarFeedOpen(open)
          if (open) void ensureCalendarFeedUrl()
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Subscribe
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscribe in Google Calendar</DialogTitle>
            <DialogDescription>
              Add this URL as an “iCal from URL” subscription in Google Calendar. Treat it like a password.
            </DialogDescription>
          </DialogHeader>

          {calendarFeedLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : calendarFeedError ? (
            <div className="text-sm text-destructive">{calendarFeedError}</div>
          ) : calendarFeedUrl ? (
            <ShareLink shareUrl={calendarFeedUrl} label="Calendar feed URL" />
          ) : (
            <div className="text-sm text-muted-foreground">No calendar link yet.</div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void rotateCalendarFeedUrl()}
              disabled={calendarFeedLoading}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Regenerate link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button
        variant="outline"
        size="icon"
        onClick={openPersonalDialog}
        aria-label="Add key date"
        title="Add key date"
      >
        <Plus className="w-4 h-4" />
      </Button>
    </>
  )

  const monthNavigation = (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMonthCursor((d) => addMonths(d, -1))}
        aria-label="Previous month"
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <div className="text-sm font-medium tabular-nums w-[10.5rem] text-center">{monthLabel}</div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMonthCursor((d) => addMonths(d, 1))}
        aria-label="Next month"
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
    </>
  )

  return (
    <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Upcoming Key Dates</CardTitle>
          <div className="text-xs text-muted-foreground tabular-nums">{upcoming.length.toLocaleString()} total</div>
        </CardHeader>
        <CardContent className="p-3 sm:p-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading key dates…</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : upcoming.length === 0 ? (
            <div className="text-sm text-muted-foreground">No upcoming key dates.</div>
          ) : (
            <div className="space-y-2">
              {upcomingVisible.map((k) => {
                const colors = k.kind === 'project' ? typeColorClasses(k.type) : typeColorClasses('')
                const label =
                  k.kind === 'project'
                    ? (k.project.companyName || k.project.title)
                    : k.title

                return (
                  <div
                    key={k.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border p-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full ${colors.pill}`}>
                          {k.kind === 'project' ? typeLabel(k.type) : 'Personal'}
                        </span>
                        <span className="text-sm font-medium tabular-nums">{formatHumanDate(k.date)}</span>
                        {k.kind === 'personal' && k.reminderAt ? <Bell className="w-4 h-4 text-muted-foreground" /> : null}
                        <span className="text-xs text-muted-foreground">
                          {k.allDay
                            ? 'All day'
                            : k.startTime && k.finishTime
                              ? `${k.startTime}–${k.finishTime}`
                              : k.startTime
                                ? k.startTime
                                : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {k.kind === 'project' ? (
                          <Link href={`/admin/projects/${k.projectId}`} className="text-sm underline underline-offset-2">
                            {label}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium">{label}</span>
                        )}
                        {k.notes ? <span className="text-xs text-muted-foreground truncate">— {k.notes}</span> : null}
                      </div>
                    </div>

                    <div className="flex-shrink-0 flex items-center gap-2">
                      {k.kind === 'project' ? (
                        <Link href={`/admin/projects/${k.projectId}`} className="flex-shrink-0">
                          <Button variant="secondary" size="sm">Open</Button>
                        </Link>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void openEditPersonalDialog(k)}
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void deletePersonalKeyDate(k.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}

              {upcoming.length > 10 ? (
                <div className="pt-1">
                  <Button variant="ghost" size="sm" onClick={() => setShowAllUpcoming((v) => !v)}>
                    {showAllUpcoming ? 'Show fewer' : `Show all (${upcoming.length.toLocaleString()})`}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarIcon className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">Calendar</CardTitle>
            </div>

            <div className="flex items-center gap-2 sm:hidden">{calendarActions}</div>
          </div>

          <div className="flex items-center justify-center gap-1 sm:hidden">{monthNavigation}</div>

          <div className="hidden sm:flex items-center gap-2">
            {calendarActions}
            <div className="flex items-center gap-1">{monthNavigation}</div>
          </div>
        </CardHeader>
        <CardContent className="p-3 sm:p-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading calendar…</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-7 gap-1 text-xs text-muted-foreground">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                  <div key={d} className="text-center py-1">
                    {d}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {monthCells.map((cell, idx) => {
                  const isToday = cell.ymd != null && cell.ymd === today
                  const dayKeyDates = cell.ymd ? keyDatesByYmd.get(cell.ymd) || [] : []

                  return (
                    <div
                      key={`${idx}-${cell.ymd || 'empty'}`}
                      className={`min-h-[64px] rounded-md border border-border p-1.5 ${
                        isToday ? 'bg-primary/5 border-primary/30' : 'bg-background'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs tabular-nums text-muted-foreground">{cell.day || ''}</div>
                      </div>

                      {dayKeyDates.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {dayKeyDates.slice(0, 6).map((k) => {
                            if (k.kind === 'project') {
                              const colors = typeColorClasses(k.type)
                              return (
                                <Link
                                  key={k.id}
                                  href={`/admin/projects/${k.projectId}`}
                                  className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5"
                                  title={`${typeLabel(k.type)} — ${k.project.companyName || k.project.title}`}
                                >
                                  <span className={`inline-block w-2 h-2 rounded-full ${colors.dot}`} />
                                  <span className="text-[10px] text-muted-foreground truncate max-w-[7.5rem]">
                                    {k.project.companyName || k.project.title}
                                  </span>
                                </Link>
                              )
                            }

                            return (
                              <button
                                key={k.id}
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5"
                                title={k.notes ? `${k.title} — ${k.notes}` : k.title}
                                onClick={() => void openEditPersonalDialog(k)}
                              >
                                <span className="inline-block w-2 h-2 rounded-full bg-foreground/40" />
                                <span className="text-[10px] text-muted-foreground truncate max-w-[7.5rem]">
                                  {k.title}
                                </span>
                              </button>
                            )
                          })}
                          {dayKeyDates.length > 6 ? (
                            <span className="text-[10px] text-muted-foreground px-1">+{dayKeyDates.length - 6}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground pt-1">
                {(['PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER'] as const).map((t) => {
                  const colors = typeColorClasses(t)
                  return (
                    <div key={t} className="flex items-center gap-1.5">
                      <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors.dot}`} />
                      <span>{typeLabel(t)}</span>
                    </div>
                  )
                })}
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-foreground/40" />
                  <span>Personal</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={personalOpen}
        onOpenChange={(open) => {
          setPersonalOpen(open)
          if (!open) setPersonalError(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{personalDraft.id ? 'Edit Key Date' : 'Add Key Date'}</DialogTitle>
            <DialogDescription>This key date is not associated with a project.</DialogDescription>
          </DialogHeader>

          {personalError ? (
            <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
              {personalError}
            </div>
          ) : null}

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">Date</div>
              <Input
                type="date"
                value={personalDraft.date}
                onChange={(e) => setPersonalDraft((p) => ({ ...p, date: e.target.value }))}
                className="h-10"
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                checked={personalDraft.allDay}
                onCheckedChange={(v) =>
                  setPersonalDraft((p) => ({ ...p, allDay: Boolean(v), startTime: '', finishTime: '' }))
                }
              />
              <div className="text-sm">All day</div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <div className="text-sm font-medium">Start</div>
                <Input
                  type="text"
                  value={personalDraft.startTime}
                  disabled={personalDraft.allDay}
                  placeholder="HH:MM"
                  inputMode="numeric"
                  onChange={(e) => setPersonalDraft((p) => ({ ...p, startTime: e.target.value }))}
                  className="h-10"
                  list="personal-key-date-start-times"
                />
                <datalist id="personal-key-date-start-times">
                  {Array.from({ length: 24 * 4 }).map((_, i) => {
                    const minutes = i * 15
                    const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
                    const mm = String(minutes % 60).padStart(2, '0')
                    const t = `${hh}:${mm}`
                    return <option key={t} value={t} />
                  })}
                </datalist>
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">Finish</div>
                <Input
                  type="text"
                  value={personalDraft.finishTime}
                  disabled={personalDraft.allDay}
                  placeholder="HH:MM"
                  inputMode="numeric"
                  onChange={(e) => setPersonalDraft((p) => ({ ...p, finishTime: e.target.value }))}
                  className="h-10"
                  list="personal-key-date-finish-times"
                />
                <datalist id="personal-key-date-finish-times">
                  {Array.from({ length: 24 * 4 }).map((_, i) => {
                    const minutes = i * 15
                    const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
                    const mm = String(minutes % 60).padStart(2, '0')
                    const t = `${hh}:${mm}`
                    return <option key={t} value={t} />
                  })}
                </datalist>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Title</div>
              <Input
                value={personalDraft.title}
                onChange={(e) => setPersonalDraft((p) => ({ ...p, title: e.target.value }))}
                placeholder="e.g., Studio maintenance"
                maxLength={120}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Notes</div>
              <Textarea
                value={personalDraft.notes}
                onChange={(e) => setPersonalDraft((p) => ({ ...p, notes: e.target.value }))}
                className="min-h-[90px] resize-y whitespace-pre-wrap"
                placeholder="Notes"
                maxLength={500}
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
                    setPersonalDraft((p) => ({
                      ...p,
                      reminderDate: '',
                      reminderTime: '',
                      reminderUserIds: [],
                    }))
                  }
                >
                  Clear
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <div className="text-sm">Reminder date</div>
                  <Input
                    type="date"
                    value={personalDraft.reminderDate}
                    onChange={(e) => setPersonalDraft((p) => ({ ...p, reminderDate: e.target.value }))}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-sm">Reminder time</div>
                  <Input
                    type="text"
                    value={personalDraft.reminderTime}
                    placeholder="HH:MM"
                    inputMode="numeric"
                    onChange={(e) => setPersonalDraft((p) => ({ ...p, reminderTime: e.target.value }))}
                    className="h-10"
                    list="personal-key-date-reminder-times"
                  />
                  <datalist id="personal-key-date-reminder-times">
                    {Array.from({ length: 24 * 4 }).map((_, i) => {
                      const minutes = i * 15
                      const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
                      const mm = String(minutes % 60).padStart(2, '0')
                      const t = `${hh}:${mm}`
                      return <option key={t} value={t} />
                    })}
                  </datalist>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Send to users</div>
                <div className="max-h-40 overflow-auto rounded-md border border-border p-2 space-y-2">
                  {(personalReminderOptions?.users || []).length === 0 ? (
                    <div className="text-xs text-muted-foreground">No users available.</div>
                  ) : (
                    (personalReminderOptions?.users || []).map((u) => (
                      <label key={u.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={personalDraft.reminderUserIds.includes(u.id)}
                          onChange={() =>
                            setPersonalDraft((p) => ({ ...p, reminderUserIds: toggleId(p.reminderUserIds, u.id) }))
                          }
                        />
                        <span className="truncate">{u.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPersonalOpen(false)} disabled={personalSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void savePersonalKeyDate()} disabled={personalSaving}>
              {personalSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
