'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch, apiPost } from '@/lib/api-client'
import { cn, formatFileSize } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'

type StorageOverview = {
  totalBytes: number
  capacityBytes: number | null
  availableBytes: number | null
  breakdown: {
    originalVideosBytes: number
    videoPreviewsBytes: number
    videoAssetsBytes: number
    commentAttachmentsBytes: number
    originalPhotosBytes: number
    photoZipBytes: number
    communicationsBytes: number
    projectFilesBytes: number
    clientFilesBytes: number
    userFilesBytes: number
  }
}

type ClosedProjectPreviewCleanupResult = {
  ok: true
  dryRun: boolean
  closedProjects: number
  projectsWithPreviews: number
  videosWithPreviews: number
  previewFiles: number
  timelineDirs: number
  deleted?: {
    previewFiles: number
    previewFilesFailed: number
    timelineDirs: number
    timelineDirsFailed: number
  }
  errors?: Array<{ projectId: string; path: string; error: string }>
  sample?: {
    projects: Array<{ id: string; title: string; videos: number }>
  }
}

interface StorageOverviewSectionProps {
  show: boolean
  setShow: (value: boolean) => void
  hideCollapse?: boolean
  autoDeletePreviewsOnClose: boolean
  setAutoDeletePreviewsOnClose: (value: boolean) => void
  onRecalculateProjectDataTotals?: () => void
  recalculateProjectDataTotalsLoading?: boolean
  recalculateProjectDataTotalsResult?: string | null
}

export function StorageOverviewSection({
  show,
  setShow,
  autoDeletePreviewsOnClose,
  setAutoDeletePreviewsOnClose,
  onRecalculateProjectDataTotals,
  recalculateProjectDataTotalsLoading,
  recalculateProjectDataTotalsResult,
  hideCollapse,
}: StorageOverviewSectionProps) {
  const [data, setData] = useState<StorageOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)

  const [closedPreviewsLoading, setClosedPreviewsLoading] = useState(false)
  const [closedPreviewsResult, setClosedPreviewsResult] =
    useState<ClosedProjectPreviewCleanupResult | null>(null)
  const [closedPreviewsError, setClosedPreviewsError] = useState<string | null>(null)

  useEffect(() => {
    if (!show || hasLoaded) return

    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch('/api/settings/storage-overview')
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || 'Failed to load storage overview')
        }
        const json = (await res.json()) as StorageOverview
        if (!cancelled) {
          setData(json)
          setHasLoaded(true)
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load storage overview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [show, hasLoaded])

  async function runClosedPreviewsCleanup(dryRun: boolean) {
    setClosedPreviewsLoading(true)
    setClosedPreviewsError(null)
    try {
      const res = await apiPost('/api/settings/delete-closed-project-previews', { dryRun })
      setClosedPreviewsResult(res as ClosedProjectPreviewCleanupResult)
    } catch (e: any) {
      setClosedPreviewsError(e?.message || 'Failed to run closed project preview cleanup')
    } finally {
      setClosedPreviewsLoading(false)
    }
  }

  const rows = useMemo(() => {
    if (!data) return []
    const total = Math.max(0, data.totalBytes)
    const b = data.breakdown
    const items = [
      { key: 'originalVideosBytes', label: 'Original Videos', bytes: b.originalVideosBytes },
      {
        key: 'videoPreviewsBytes',
        label: 'Video Previews',
        bytes: b.videoPreviewsBytes,
      },
      { key: 'videoAssetsBytes', label: 'Video Assets', bytes: b.videoAssetsBytes },
      {
        key: 'commentAttachmentsBytes',
        label: 'Comment Attachments',
        bytes: b.commentAttachmentsBytes,
      },
      { key: 'originalPhotosBytes', label: 'Original Photos', bytes: b.originalPhotosBytes },
      { key: 'photoZipBytes', label: 'Photo ZIP files & previews', bytes: b.photoZipBytes },
      { key: 'communicationsBytes', label: 'External Communication', bytes: b.communicationsBytes },
      { key: 'projectFilesBytes', label: 'Project Files', bytes: b.projectFilesBytes },
      { key: 'clientFilesBytes', label: 'Client Files', bytes: b.clientFilesBytes },
      { key: 'userFilesBytes', label: 'User Files', bytes: b.userFilesBytes },
    ]
    return items.map((it) => {
      const bytes = Math.max(0, it.bytes)
      const pct = total > 0 ? Math.round((bytes / total) * 1000) / 10 : 0
      return { ...it, bytes, pct }
    })
  }, [data])

  const totalLabel = useMemo(
    () => formatFileSize(Math.max(0, data?.totalBytes ?? 0)),
    [data]
  )

  const availableLabel = useMemo(() => {
    const v = data?.availableBytes
    if (v == null || !Number.isFinite(v) || v < 0) return null
    return formatFileSize(v)
  }, [data])

  const capacityLabel = useMemo(() => {
    const v = data?.capacityBytes
    if (v == null || !Number.isFinite(v) || v < 0) return null
    return formatFileSize(v)
  }, [data])

  return (
    <Card className="border-border">
      <CardHeader
        className={hideCollapse ? undefined : "cursor-pointer hover:bg-accent/50 transition-colors"}
        onClick={hideCollapse ? undefined : () => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Storage Overview</CardTitle>
            <CardDescription>
              System-wide storage usage and preview management
            </CardDescription>
          </div>
          {!hideCollapse && (show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ))}
        </div>
      </CardHeader>

      {(show || hideCollapse) && (
        <CardContent className="space-y-6 border-t pt-4">
          {/* Storage bars */}
          <div className="space-y-4">
            {loading && !data ? (
              <p className="text-sm text-muted-foreground">Loading storage data…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : data ? (
              <>
                {loading ? (
                  <div className="text-xs text-muted-foreground">Refreshing…</div>
                ) : null}

                <div className="rounded-lg border border-border bg-background px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm text-muted-foreground">Total tracked storage</div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground flex-shrink-0"
                        disabled={!onRecalculateProjectDataTotals || recalculateProjectDataTotalsLoading}
                        title={recalculateProjectDataTotalsLoading ? 'Recalculating…' : 'Recalculate & refresh'}
                        onClick={() => {
                          onRecalculateProjectDataTotals?.()
                          setHasLoaded(false)
                        }}
                      >
                        <RefreshCw className={cn('w-3.5 h-3.5', recalculateProjectDataTotalsLoading && 'animate-spin')} />
                      </Button>
                      <div className="text-lg font-semibold tabular-nums">{totalLabel}</div>
                    </div>
                  </div>
                  {capacityLabel && (
                    <div className="mt-1 flex items-baseline justify-between gap-3">
                      <div className="text-xs text-muted-foreground">Volume capacity</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {capacityLabel}
                      </div>
                    </div>
                  )}
                  {availableLabel && (
                    <div className="mt-1 flex items-baseline justify-between gap-3">
                      <div className="text-xs text-muted-foreground">Available space</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {availableLabel}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {rows.map((r) => (
                    <div key={r.key} className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium">{r.label}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatFileSize(r.bytes)}
                          {data.totalBytes > 0 ? ` • ${r.pct}%` : ''}
                        </div>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full bg-primary/70',
                            r.bytes === 0 && 'bg-muted'
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }}
                          aria-label={`${r.label} ${r.pct}%`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {/* Auto-delete previews on close toggle */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="autoDeletePreviewsOnClose">
                  Auto-delete video previews and timeline sprites when project is closed
                </Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, all generated preview files and timeline sprite previews will be
                  deleted when a project is closed to save disk space. They will be automatically
                  regenerated if the project is reopened.
                </p>
              </div>
              <Switch
                id="autoDeletePreviewsOnClose"
                checked={autoDeletePreviewsOnClose}
                onCheckedChange={setAutoDeletePreviewsOnClose}
              />
            </div>
          </div>

          {/* Delete previews for closed projects (manual cleanup) */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Delete previews for closed projects</Label>
                <p className="text-xs text-muted-foreground">
                  Finds all CLOSED projects that still have preview files (480p, 720p, 1080p) or
                  timeline sprite directories on disk, and deletes them to reclaim storage. Database
                  fields are cleared so previews will regenerate if the project is re-opened. Run a
                  dry-run first to preview impact.
                </p>

                {closedPreviewsError ? (
                  <p className="text-xs text-destructive">{closedPreviewsError}</p>
                ) : null}

                {closedPreviewsResult ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Closed projects: {closedPreviewsResult.closedProjects} total,{' '}
                      {closedPreviewsResult.projectsWithPreviews} with previews
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Videos with previews: {closedPreviewsResult.videosWithPreviews}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Preview files: {closedPreviewsResult.previewFiles}; timeline sprite dirs:{' '}
                      {closedPreviewsResult.timelineDirs}
                    </p>
                    {closedPreviewsResult.deleted ? (
                      <p className="text-xs text-muted-foreground">
                        Deleted: {closedPreviewsResult.deleted.previewFiles} preview files
                        {closedPreviewsResult.deleted.previewFilesFailed
                          ? ` (${closedPreviewsResult.deleted.previewFilesFailed} failed)`
                          : ''}
                        , {closedPreviewsResult.deleted.timelineDirs} timeline dirs
                        {closedPreviewsResult.deleted.timelineDirsFailed
                          ? ` (${closedPreviewsResult.deleted.timelineDirsFailed} failed)`
                          : ''}
                      </p>
                    ) : null}
                    {closedPreviewsResult.errors?.length ? (
                      <p className="text-xs text-muted-foreground">
                        Errors: {closedPreviewsResult.errors.length}
                      </p>
                    ) : null}

                    {closedPreviewsResult.sample?.projects?.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show affected projects
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">
                              Affected projects (first 10)
                            </div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {closedPreviewsResult.sample.projects
                                .map(
                                  (p) =>
                                    `${p.id}\t${p.title} (${p.videos} video${p.videos !== 1 ? 's' : ''})`
                                )
                                .join('\n')}
                            </pre>
                          </div>

                          {closedPreviewsResult.errors?.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">
                                Errors (first 20)
                              </div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {closedPreviewsResult.errors
                                  .slice(0, 20)
                                  .map((e) => `${e.projectId}: ${e.path}: ${e.error}`)
                                  .join('\n')}
                              </pre>
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  disabled={closedPreviewsLoading}
                  onClick={() => void runClosedPreviewsCleanup(true)}
                >
                  {closedPreviewsLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={closedPreviewsLoading}
                  onClick={() => {
                    if (
                      !confirm(
                        'Delete all preview files and timeline sprites for CLOSED projects? This cannot be undone.'
                      )
                    )
                      return
                    void runClosedPreviewsCleanup(false)
                  }}
                >
                  {closedPreviewsLoading ? 'Running…' : 'Delete previews'}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
