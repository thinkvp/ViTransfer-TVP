'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { cn, formatFileSize } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChevronDown, ChevronUp } from 'lucide-react'

type StorageSummary = {
  totalBytes: number
  diskTotalBytes?: number | null
  diskOtherBytes?: number | null
  dropboxConfigured?: boolean
  dropboxBytes?: number | null
  capacityBytes?: number | null
  availableBytes?: number | null
  breakdown: {
    originalVideosBytes?: number
    videoPreviewsBytes?: number
    videosBytes: number
    videoAssetsBytes: number
    commentAttachmentsBytes: number
    originalPhotosBytes?: number
    photoZipBytes?: number
    photosBytes: number
    projectFilesBytes: number

    // Optional newer fields (may be omitted by older servers)
    // If present, they are folded into the existing rows.
    socialPhotosBytes?: number
    albumZipFullBytes?: number
    albumZipSocialBytes?: number
    communicationsBytes?: number
  }

  // Optional on-disk breakdown that matches actual volume folder sizes.
  // When present, it should be used alongside diskTotalBytes.
  diskBreakdown?: {
    originalVideosBytes?: number
    videoPreviewsBytes?: number
    videosBytes: number
    videoAssetsBytes: number
    commentAttachmentsBytes: number
    originalPhotosBytes?: number
    photoZipBytes?: number
    photosBytes: number
    communicationsBytes?: number
    projectFilesBytes: number
  } | null
}

type Row = {
  key: string
  label: string
  bytes: number
  pct: number
}

export function ProjectStorageUsage({
  projectId,
  refreshTrigger,
}: {
  projectId: string
  refreshTrigger?: number
}) {
  const [data, setData] = useState<StorageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [hasLoadedDiskDetails, setHasLoadedDiskDetails] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadSummary() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/projects/${projectId}/storage?includeDisk=1`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || 'Failed to load storage usage')
        }
        const json = (await res.json()) as StorageSummary
        if (!cancelled) {
          setData((prev) => ({
            ...(prev || {}),
            ...json,
            diskTotalBytes: prev?.diskTotalBytes ?? json.diskTotalBytes ?? null,
            diskOtherBytes: prev?.diskOtherBytes ?? json.diskOtherBytes ?? null,
            capacityBytes: prev?.capacityBytes ?? json.capacityBytes,
            availableBytes: prev?.availableBytes ?? json.availableBytes,
            diskBreakdown: prev?.diskBreakdown ?? json.diskBreakdown ?? null,
          }))
          setHasLoadedDiskDetails(true)
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load storage usage')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadSummary()
    return () => {
      cancelled = true
    }
  }, [projectId, refreshTrigger])

  useEffect(() => {
    if (!expanded || hasLoadedDiskDetails) return

    let cancelled = false
    async function loadDiskDetails() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/projects/${projectId}/storage?includeDisk=1`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || 'Failed to load storage usage')
        }
        const json = (await res.json()) as StorageSummary
        if (!cancelled) {
          setData((prev) => (prev ? { ...prev, ...json } : json))
          setHasLoadedDiskDetails(true)
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load storage usage')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadDiskDetails()
    return () => {
      cancelled = true
    }
  }, [expanded, hasLoadedDiskDetails, projectId])

  const rows: Row[] = useMemo(() => {
    const effectiveTotal = Math.max(0, Number((data?.diskTotalBytes ?? data?.totalBytes) || 0))
    const b = (data?.diskBreakdown ?? data?.breakdown) as StorageSummary['breakdown'] | null | undefined
    if (!b) return []

    const baseBreakdown = data?.breakdown
    const hasDetailedSplitRows =
      typeof (b as any).originalVideosBytes === 'number' ||
      typeof (b as any).videoPreviewsBytes === 'number' ||
      typeof (b as any).originalPhotosBytes === 'number' ||
      typeof (b as any).photoZipBytes === 'number' ||
      typeof (baseBreakdown as any)?.originalVideosBytes === 'number' ||
      typeof (baseBreakdown as any)?.videoPreviewsBytes === 'number' ||
      typeof (baseBreakdown as any)?.originalPhotosBytes === 'number' ||
      typeof (baseBreakdown as any)?.photoZipBytes === 'number'

    const originalVideosBytes = Number((b as any).originalVideosBytes ?? (baseBreakdown as any)?.originalVideosBytes ?? 0)
    const videoPreviewsBytes = Number((b as any).videoPreviewsBytes ?? (baseBreakdown as any)?.videoPreviewsBytes ?? 0)
    const originalPhotosBytes = Number((b as any).originalPhotosBytes ?? (baseBreakdown as any)?.originalPhotosBytes ?? 0)
    const photoZipBytes = Number((b as any).photoZipBytes ?? (baseBreakdown as any)?.photoZipBytes ?? 0)
    const hasSplitRows =
      hasDetailedSplitRows ||
      originalVideosBytes > 0 ||
      videoPreviewsBytes > 0 ||
      originalPhotosBytes > 0 ||
      photoZipBytes > 0

    const communicationsBytes = Number((b as any).communicationsBytes || 0)
    const projectFilesBytes = Number(b.projectFilesBytes || 0)
    const diskOtherBytes = Math.max(0, Number(data?.diskOtherBytes ?? 0))

    const items: Array<{ key: Row['key']; label: string; bytes: number }> = hasSplitRows
      ? [
          { key: 'originalVideosBytes', label: 'Original Videos', bytes: originalVideosBytes },
          { key: 'videoPreviewsBytes', label: 'Video Previews', bytes: videoPreviewsBytes },
          { key: 'videoAssetsBytes', label: 'Video Assets', bytes: Number(b.videoAssetsBytes || 0) },
          { key: 'commentAttachmentsBytes', label: 'Comment Attachments', bytes: Number(b.commentAttachmentsBytes || 0) },
          { key: 'originalPhotosBytes', label: 'Original Photos', bytes: originalPhotosBytes },
          { key: 'photoZipBytes', label: 'Photo ZIP files & previews', bytes: photoZipBytes },
          { key: 'communicationsBytes', label: 'External Communication', bytes: communicationsBytes },
          { key: 'projectFilesBytes', label: 'Project Files', bytes: projectFilesBytes },
          { key: 'diskOtherBytes', label: 'Other files', bytes: diskOtherBytes },
        ]
      : [
          {
            key: 'videosBytes',
            label: 'Videos',
            bytes: Number(b.videosBytes || 0),
          },
          { key: 'videoAssetsBytes', label: 'Video Assets', bytes: Number(b.videoAssetsBytes || 0) },
          { key: 'commentAttachmentsBytes', label: 'Comment Attachments', bytes: Number(b.commentAttachmentsBytes || 0) },
          {
            key: 'photosBytes',
            label: 'Photos',
            bytes:
              Number(b.photosBytes || 0) +
              Number((b as any).socialPhotosBytes || 0) +
              Number((b as any).albumZipFullBytes || 0) +
              Number((b as any).albumZipSocialBytes || 0),
          },
          { key: 'communicationsBytes', label: 'External Communication', bytes: communicationsBytes },
          { key: 'projectFilesBytes', label: 'Project Files', bytes: projectFilesBytes },
          { key: 'diskOtherBytes', label: 'Other files', bytes: diskOtherBytes },
        ]

    return items.filter((it) => Math.max(0, it.bytes) > 0).map((it) => {
      const bytes = Math.max(0, it.bytes)
      const pct = effectiveTotal > 0 ? Math.round((bytes / effectiveTotal) * 1000) / 10 : 0
      return { ...it, bytes, pct }
    })
  }, [data])

  const totalLabel = useMemo(() => {
    const total = Number((data?.diskTotalBytes ?? data?.totalBytes) || 0)
    return formatFileSize(total)
  }, [data])

  const availableLabel = useMemo(() => {
    const available = Number(data?.availableBytes ?? NaN)
    if (!Number.isFinite(available) || available < 0) return null
    return formatFileSize(available)
  }, [data])

  const dropboxLabel = useMemo(() => {
    const dropboxBytes = Number(data?.dropboxBytes ?? NaN)
    if (!Number.isFinite(dropboxBytes) || dropboxBytes < 0) return null
    return formatFileSize(dropboxBytes)
  }, [data])

  if (!loading && !error && data && rows.length === 0 && Number((data.diskTotalBytes ?? data.totalBytes) || 0) <= 0) {
    return null
  }

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Project Data</CardTitle>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-sm font-semibold tabular-nums text-foreground">
              {loading && !data ? 'Loading…' : error ? '—' : !data ? '—' : totalLabel}
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
          {error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground py-2">No storage data available.</div>
          ) : (
            <>
              {loading ? <div className="text-xs text-muted-foreground">Refreshing…</div> : null}
              <div className="rounded-lg border border-border bg-background px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm text-muted-foreground">Total</div>
                  <div className="text-lg font-semibold tabular-nums">{totalLabel}</div>
                </div>
                {typeof data.diskTotalBytes === 'number' && (
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <div className="text-xs text-muted-foreground">Source</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      On disk
                    </div>
                  </div>
                )}
                {data.dropboxConfigured && dropboxLabel && (
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <div className="text-xs text-muted-foreground">Dropbox (not counted in totals)</div>
                    <div className="text-xs text-muted-foreground tabular-nums">{dropboxLabel}</div>
                  </div>
                )}
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
                        {formatFileSize(r.bytes)}{((data.diskTotalBytes ?? data.totalBytes) || 0) > 0 ? ` • ${r.pct}%` : ''}
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
