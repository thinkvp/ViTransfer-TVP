'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { cn, formatFileSize } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChevronDown, ChevronUp } from 'lucide-react'

type StorageSummary = {
  totalBytes: number
  capacityBytes?: number | null
  availableBytes?: number | null
  breakdown: {
    videosBytes: number
    videoAssetsBytes: number
    commentAttachmentsBytes: number
    photosBytes: number
    projectFilesBytes: number
  }
}

type Row = {
  key: keyof StorageSummary['breakdown']
  label: string
  bytes: number
  pct: number
}

export function ProjectStorageUsage({ projectId }: { projectId: string }) {
  const [data, setData] = useState<StorageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/projects/${projectId}/storage`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || 'Failed to load storage usage')
        }
        const json = (await res.json()) as StorageSummary
        if (!cancelled) setData(json)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load storage usage')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const rows: Row[] = useMemo(() => {
    const total = Math.max(0, Number(data?.totalBytes || 0))
    const b = data?.breakdown
    if (!b) return []

    const items: Array<{ key: Row['key']; label: string; bytes: number }> = [
      { key: 'videosBytes', label: 'Videos', bytes: Number(b.videosBytes || 0) },
      { key: 'videoAssetsBytes', label: 'Video Assets', bytes: Number(b.videoAssetsBytes || 0) },
      { key: 'commentAttachmentsBytes', label: 'Comment Attachments', bytes: Number(b.commentAttachmentsBytes || 0) },
      { key: 'photosBytes', label: 'Photos', bytes: Number(b.photosBytes || 0) },
      { key: 'projectFilesBytes', label: 'Project Files', bytes: Number(b.projectFilesBytes || 0) },
    ]

    return items
      .map((it) => {
        const bytes = Math.max(0, it.bytes)
        const pct = total > 0 ? Math.round((bytes / total) * 1000) / 10 : 0
        return { ...it, pct }
      })
      .sort((a, b2) => b2.bytes - a.bytes)
  }, [data])

  const totalLabel = useMemo(() => {
    const total = Number(data?.totalBytes || 0)
    return formatFileSize(total)
  }, [data])

  const availableLabel = useMemo(() => {
    const available = Number(data?.availableBytes ?? NaN)
    if (!Number.isFinite(available) || available < 0) return null
    return formatFileSize(available)
  }, [data])

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Storage Usage</CardTitle>
            <CardDescription>Total used by this project</CardDescription>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? 'Loading…' : error ? '—' : !data ? '—' : totalLabel}
            </div>
            {expanded ? (
              <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          {loading ? (
            <div className="text-sm text-muted-foreground py-2">Loading storage usage...</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground py-2">No storage data available.</div>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-background px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm text-muted-foreground">Total</div>
                  <div className="text-lg font-semibold tabular-nums">{totalLabel}</div>
                </div>
                {availableLabel && (
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <div className="text-xs text-muted-foreground">Available space</div>
                    <div className="text-xs text-muted-foreground tabular-nums">{availableLabel}</div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {rows.map((r) => (
                  <div key={r.key} className="space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">{r.label}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {formatFileSize(r.bytes)}{data.totalBytes > 0 ? ` • ${r.pct}%` : ''}
                      </div>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full bg-primary/70', r.bytes === 0 && 'bg-muted')}
                        style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }}
                        aria-label={`${r.label} ${r.pct}%`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
