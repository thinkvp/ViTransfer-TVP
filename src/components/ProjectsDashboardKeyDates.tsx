'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react'
import { apiJson } from '@/lib/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

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

type KeyDatesResponse = {
  today: string // YYYY-MM-DD
  keyDates: ProjectKeyDateRow[]
}

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

  const upcoming = useMemo(() => {
    const all = data?.keyDates || []
    return all.filter((k) => k.date >= today)
  }, [data?.keyDates, today])

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
    const map = new Map<string, ProjectKeyDateRow[]>()
    for (const k of data?.keyDates || []) {
      const list = map.get(k.date) || []
      list.push(k)
      map.set(k.date, list)
    }

    for (const [ymd, list] of map.entries()) {
      list.sort((a, b) => {
        if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime)
        if (a.startTime && !b.startTime) return -1
        if (!a.startTime && b.startTime) return 1
        return a.id.localeCompare(b.id)
      })
      map.set(ymd, list)
    }

    return map
  }, [data?.keyDates])

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
                const colors = typeColorClasses(k.type)
                const projectLabel = k.project.companyName || k.project.title

                return (
                  <div
                    key={k.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border p-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full ${colors.pill}`}>{typeLabel(k.type)}</span>
                        <span className="text-sm font-medium tabular-nums">{formatHumanDate(k.date)}</span>
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
                        <Link href={`/admin/projects/${k.projectId}`} className="text-sm underline underline-offset-2">
                          {projectLabel}
                        </Link>
                        {k.notes ? <span className="text-xs text-muted-foreground truncate">— {k.notes}</span> : null}
                      </div>
                    </div>

                    <Link href={`/admin/projects/${k.projectId}`} className="flex-shrink-0">
                      <Button variant="secondary" size="sm">Open</Button>
                    </Link>
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
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Calendar</CardTitle>
          </div>
          <div className="flex items-center gap-1">
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
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
