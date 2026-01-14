'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'

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

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!shareToken) return
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/admin/sales/tracking/${shareToken}`, { cache: 'no-store' })
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

  const openedCount = useMemo(() => (data?.emails || []).filter((e) => e.openedAt).length, [data])
  const emailCount = data?.emails?.length || 0
  const viewCount = data?.views?.length || 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Views &amp; Tracking</CardTitle>
            <p className="text-sm text-muted-foreground">
              Email sends/opens and public link views (if analytics tracking is enabled).
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Emails: {emailCount} (opened {openedCount})</div>
            <div>Views: {viewCount}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>

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
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Public link views</h3>
              <span className="text-xs text-gray-500">Token: {data.share.token.slice(0, 8)}…</span>
            </div>

            {data.views.length === 0 ? (
              <div className="text-sm text-gray-600">No views recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="py-2 pr-3">Viewed at</th>
                      <th className="py-2 pr-3">IP</th>
                      <th className="py-2">User agent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.views.map((v) => (
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
              </div>
            )}
          </div>

          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Emails</h3>
              <span className="text-xs text-gray-500">Opens require tracking pixels</span>
            </div>

            {data.emails.length === 0 ? (
              <div className="text-sm text-gray-600">No emails recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="py-2 pr-3">To</th>
                      <th className="py-2 pr-3">Sent at</th>
                      <th className="py-2">Opened at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.emails.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{e.recipientEmail}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(e.sentAt)}</td>
                        <td className="py-2 whitespace-nowrap">{formatDateTime(e.openedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      </CardContent>
    </Card>
  )
}
