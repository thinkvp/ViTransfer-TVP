
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { apiFetch } from '@/lib/api-client'
import { useRouter } from 'next/navigation'

type NotificationRow = {
  id: string
  type: string
  projectId: string | null
  success: boolean
  statusCode: number | null
  message: string | null
  details: any
  sentAt: string
}

type NotificationsResponse = {
  items: NotificationRow[]
  nextBefore: string | null
  unreadCount: number
  lastSeenAt: string | null
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function normalizeDetails(details: any): { payloadTitle?: string; payloadMessage?: string; projectName?: string; lines: Array<[string, string]> } {
  const payload = details?.__payload
  const payloadTitle = typeof payload?.title === 'string' ? payload.title : undefined
  const payloadMessage = typeof payload?.message === 'string' ? payload.message : undefined
  const projectName = typeof payload?.projectName === 'string' ? payload.projectName : undefined

  function isHiddenDetailKey(key: string): boolean {
    if (key === '__payload' || key === '__link' || key === '__delivery') return true
    const normalizedKey = key.toLowerCase().replace(/[_\-\s]/g, '')
    return normalizedKey === 'salesdocid' || normalizedKey === 'salesdoctype'
  }

  const entries: Array<[string, any]> = details && typeof details === 'object'
    ? (Object.entries(details as Record<string, any>) as Array<[string, any]>)
    : []

  const lines: Array<[string, string]> = entries
    .filter(([key]) => !isHiddenDetailKey(key))
    .map(([key, value]): [string, string] => {
      if (value === null || value === undefined) return [key, '']
      if (typeof value === 'string') return [key, value]
      try {
        return [key, JSON.stringify(value)]
      } catch {
        return [key, String(value)]
      }
    })
    .filter(([key, value]) => {
      const normalizedKey = key.toLowerCase().replace(/[_\-\s]/g, '')
      const valueText = typeof value === 'string' ? value : String(value)

      // Avoid repeating project name: it's already displayed under the title.
      if (projectName) {
        const isProjectKey = normalizedKey === 'project' || normalizedKey === 'projectname' || normalizedKey === 'projecttitle'
        if (isProjectKey && normalizeText(valueText) === normalizeText(projectName)) return false
      }

      // Avoid showing title/message again if they were logged redundantly.
      if (payloadTitle && (normalizedKey === 'title' || normalizedKey === 'notificationtitle') && normalizeText(valueText) === normalizeText(payloadTitle)) {
        return false
      }
      if (payloadMessage && (normalizedKey === 'message' || normalizedKey === 'notificationmessage') && normalizeText(valueText) === normalizeText(payloadMessage)) {
        return false
      }

      return true
    })

  return { payloadTitle, payloadMessage, projectName, lines }
}

export default function NotificationsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationRow[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null)

  const pollingRef = useRef<number | null>(null)
  const itemsRef = useRef<NotificationRow[]>([])
  const openRef = useRef(false)

  function resolveHref(n: NotificationRow): string | null {
    const explicit = typeof n?.details?.__link?.href === 'string' ? String(n.details.__link.href) : ''
    if (explicit.startsWith('/')) return explicit

    // Sales doc notifications
    const docType = typeof n?.details?.salesDocType === 'string' ? n.details.salesDocType : null
    const docId = typeof n?.details?.salesDocId === 'string' ? n.details.salesDocId : null
    if (docType && docId) {
      if (docType === 'QUOTE') return `/admin/sales/quotes/${encodeURIComponent(docId)}`
      if (docType === 'INVOICE') return `/admin/sales/invoices/${encodeURIComponent(docId)}`
    }

    if (n.type === 'SALES_QUOTE_VIEWED' || n.type === 'SALES_QUOTE_ACCEPTED') {
      const quoteId = typeof n?.details?.salesQuoteId === 'string' ? n.details.salesQuoteId : null
      if (quoteId) return `/admin/sales/quotes/${encodeURIComponent(quoteId)}`
    }
    if (n.type === 'SALES_INVOICE_VIEWED' || n.type === 'SALES_INVOICE_PAID') {
      const invoiceId = typeof n?.details?.salesInvoiceId === 'string' ? n.details.salesInvoiceId : null
      if (invoiceId) return `/admin/sales/invoices/${encodeURIComponent(invoiceId)}`
    }

    // Default project navigation for project-related notifications
    if (n.projectId) return `/admin/projects/${encodeURIComponent(n.projectId)}`
    return null
  }

  // lastSeenAt is tracked server-side (NotificationReadState).

  const markAllSeen = useCallback(async (currentItems: NotificationRow[]) => {
    if (!currentItems.length) {
      setUnreadCount(0)
      return
    }

    const newest = currentItems[0]
    try {
      const res = await apiFetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: newest.sentAt }),
      })
      if (res.ok) {
        setLastSeenAt(newest.sentAt)
        setUnreadCount(0)
      }
    } catch {
      // ignore
    }
  }, [])

  const fetchPage = useCallback(async (params?: { before?: string | null; replace?: boolean; markSeen?: boolean }) => {
    const before = params?.before ?? null
    const replace = params?.replace ?? false
    const markSeen = params?.markSeen ?? false

    setLoadError(null)

    const setter = replace ? setLoading : setLoadingMore
    setter(true)
    try {
      const url = new URL('/api/notifications', window.location.origin)
      url.searchParams.set('limit', '20')
      url.searchParams.set('successOnly', '1')
      if (before) url.searchParams.set('before', before)

      const res = await apiFetch(url.pathname + url.search)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Request failed (${res.status})`)
      }

      const data = (await res.json()) as NotificationsResponse
      setNextBefore(data.nextBefore)
      setLastSeenAt(data.lastSeenAt)
      setItems((prev) => (replace ? data.items : [...prev, ...data.items]))

      if (replace) setUnreadCount(Number.isFinite(data.unreadCount) ? data.unreadCount : 0)

      if (markSeen && replace) {
        await markAllSeen(data.items)
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load notifications')
    } finally {
      setter(false)
    }
  }, [markAllSeen])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    openRef.current = open
  }, [open])

  // Initial fetch + polling for badge count.
  useEffect(() => {
    fetchPage({ replace: true })

    pollingRef.current = window.setInterval(() => {
      // Lightweight refresh: just refetch first page to update badge.
      fetchPage({ replace: true, markSeen: openRef.current })
    }, 30_000)

    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current)
    }
  }, [fetchPage])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          // Ensure we have fresh content when opening.
          fetchPage({ replace: true, markSeen: true })
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Notifications"
          title="Notifications"
          className="relative p-2 w-9 sm:w-10"
        >
          <Bell className="h-4 w-4 sm:h-5 sm:w-5" />
          {unreadCount > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] leading-[18px] text-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="!p-0 w-[92vw] sm:w-[420px] max-w-[92vw] h-[80dvh] max-h-[80dvh] overflow-hidden data-[state=open]:!animate-none data-[state=closed]:!animate-none"
      >
        <div className="flex h-full flex-col">
          <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border">
            <div className="text-sm font-semibold text-foreground">Notifications</div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : loadError ? (
              <div className="p-4 text-sm text-red-600">{loadError}</div>
            ) : items.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No notifications yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {items.map((n) => {
                  const { payloadTitle, payloadMessage, projectName, lines } = normalizeDetails(n.details)
                  // Prefer the payload message as the single, human-readable primary line.
                  // This avoids the common "title + sentence saying the same thing" duplication.
                  const title = payloadMessage || payloadTitle || n.type
                  const href = resolveHref(n)
                  const clickable = Boolean(href)
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={
                        clickable
                          ? 'w-full text-left px-4 sm:px-5 py-3 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                          : 'w-full text-left px-4 sm:px-5 py-3 cursor-default'
                      }
                      disabled={!clickable}
                      onClick={() => {
                        if (!href) return
                        setOpen(false)
                        router.push(href)
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{title}</div>
                          {projectName ? <div className="text-xs text-muted-foreground truncate">{projectName}</div> : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground whitespace-nowrap">{formatTime(n.sentAt)}</div>
                      </div>
                      {lines.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {lines.map(([k, v]) => (
                            <div key={k} className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground/80">{k}:</span> {v}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {!n.success ? (
                        <div className="mt-2 text-xs text-red-600">Send failed: {n.message || 'Unknown error'}</div>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {nextBefore ? (
            <div className="px-4 sm:px-5 py-3 border-t border-border">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => fetchPage({ before: nextBefore, replace: false })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
