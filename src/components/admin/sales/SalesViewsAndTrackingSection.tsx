'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'

const MAX_ENTRIES = 30
const PAGE_SIZE = 10

type TrackingPayload = {
  share: {
    token: string
    type: 'QUOTE' | 'INVOICE'
    docId: string
    createdAt: string
    revokedAt: string | null
    expiresAt: string | null
  }
  views: Array<{
    id: string
    createdAt: string
    ipAddress: string | null
    userAgent: string | null
  }>
  emails: Array<{
    id: string
    token: string
    recipientEmail: string
    sentAt: string
    openedAt: string | null
  }>
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

export function SalesViewsAndTrackingSection({ shareToken, refreshKey }: { shareToken?: string | null; refreshKey?: unknown }) {
  const [data, setData] = useState<TrackingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewsPage, setViewsPage] = useState(1)
  const [emailsPage, setEmailsPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!shareToken) return
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/admin/sales/tracking/${shareToken}?limit=${MAX_ENTRIES}`, { cache: 'no-store' })
        if (!res.ok) {
          const msg = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(msg?.error || `Failed to load tracking (${res.status})`)
        }
        const json = (await res.json()) as TrackingPayload
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load tracking')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [refreshKey, shareToken])

  useEffect(() => {
    setViewsPage(1)
    setEmailsPage(1)
  }, [data?.share?.token])

  const views = useMemo(() => (data?.views || []).slice(0, MAX_ENTRIES), [data])
  const emails = useMemo(() => (data?.emails || []).slice(0, MAX_ENTRIES), [data])

  const viewCount = views.length
  const emailCount = emails.length
  const openedCount = useMemo(() => emails.filter((e) => e.openedAt).length, [emails])

  const viewTotalPages = Math.max(1, Math.ceil(viewCount / PAGE_SIZE))
  const emailTotalPages = Math.max(1, Math.ceil(emailCount / PAGE_SIZE))

  useEffect(() => {
    setViewsPage((p) => Math.min(Math.max(1, p), viewTotalPages))
  }, [viewTotalPages])

  useEffect(() => {
    setEmailsPage((p) => Math.min(Math.max(1, p), emailTotalPages))
  }, [emailTotalPages])

  const visibleViews = useMemo(() => {
    const start = (viewsPage - 1) * PAGE_SIZE
    return views.slice(start, start + PAGE_SIZE)
  }, [views, viewsPage])

  const visibleEmails = useMemo(() => {
    const start = (emailsPage - 1) * PAGE_SIZE
    return emails.slice(start, start + PAGE_SIZE)
  }, [emails, emailsPage])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <CardTitle className="whitespace-normal">Views &amp; Tracking</CardTitle>
            <p className="hidden sm:block text-sm text-muted-foreground">
              Email sends/opens and public link views (if analytics tracking is enabled).
            </p>
          </div>
          <div className="shrink-0 text-right text-sm text-muted-foreground">
            <div>Emails: {emailCount} (opened {openedCount})</div>
            <div>Views: {viewCount}</div>
            <div className="text-xs">Showing up to {MAX_ENTRIES}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0">

      {shareToken === undefined && (
        <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          Checking for a public share link…
        </div>
      )}

      {shareToken !== undefined && !shareToken && (
        <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          No public share link exists yet, so there are no view events to show.
        </div>
      )}

      {shareToken && loading && (
        <div className="text-sm text-muted-foreground">Loading tracking…</div>
      )}

      {shareToken && error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {shareToken && data && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0 rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Public link views</h3>
              <span className="text-xs text-gray-500">Token: {data.share.token.slice(0, 8)}…</span>
            </div>

            {views.length === 0 ? (
              <div className="text-sm text-gray-600">No views recorded yet.</div>
            ) : (
              <div className="max-w-full overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="py-2 pr-3">Viewed at</th>
                      <th className="py-2 pr-3">IP</th>
                      <th className="py-2">User agent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleViews.map((v) => (
                      <tr key={v.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(v.createdAt)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{v.ipAddress || '—'}</td>
                        <td className="py-2 truncate max-w-[22rem]" title={v.userAgent || ''}>
                          {v.userAgent || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {viewTotalPages > 1 && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground tabular-nums">Page {viewsPage} of {viewTotalPages}</p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewsPage((p) => Math.max(1, p - 1))}
                        disabled={viewsPage === 1}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewsPage((p) => Math.min(viewTotalPages, p + 1))}
                        disabled={viewsPage === viewTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Emails</h3>
              <span className="text-xs text-gray-500">Opens require tracking pixels</span>
            </div>

            {emails.length === 0 ? (
              <div className="text-sm text-gray-600">No emails recorded yet.</div>
            ) : (
              <div className="max-w-full overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="py-2 pr-3">To</th>
                      <th className="py-2 pr-3">Sent at</th>
                      <th className="py-2">Opened at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEmails.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{e.recipientEmail}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(e.sentAt)}</td>
                        <td className="py-2 whitespace-nowrap">{formatDateTime(e.openedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {emailTotalPages > 1 && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground tabular-nums">Page {emailsPage} of {emailTotalPages}</p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEmailsPage((p) => Math.max(1, p - 1))}
                        disabled={emailsPage === 1}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEmailsPage((p) => Math.min(emailTotalPages, p + 1))}
                        disabled={emailsPage === emailTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      </CardContent>
    </Card>
  )
}
