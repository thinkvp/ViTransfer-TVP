import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { apiPost } from '@/lib/api-client'
import {
  MAX_DOWNLOAD_CHUNK_SIZE_MB,
  MAX_UPLOAD_CHUNK_SIZE_MB,
  MIN_DOWNLOAD_CHUNK_SIZE_MB,
  MIN_UPLOAD_CHUNK_SIZE_MB,
} from '@/lib/transfer-tuning'

type OrphanProjectFileCleanupResult = {
  ok: true
  dryRun: boolean
  scannedDirectories: number
  scannedProjectDirectories?: number
  scannedProjects?: number
  scannedFiles: number
  orphanFiles: number
  orphanFileBytes: number
  sample?: {
    orphanPaths: string[]
    projectIds: string[]
  }
  deleted?: {
    filesDeleted: number
    filesFailed: number
    emptyDirsPruned: number
  }
  errors?: Array<{ path: string; error: string }>
}

type NotificationBacklogResult = {
  ok: true
  dryRun: boolean
  totalUnsent?: number
  staleCount?: number
  recentCount?: number
  oldestCreatedAt?: string | null
  dismissed?: number
  staleSample?: Array<{
    id: string
    createdAt: string
    projectId: string | null
    projectTitle: string | null
    type: string
    pendingTargets: string[]
    attempts: {
      clients: number
      admins: number
    }
    failed: {
      clients: boolean
      admins: boolean
    }
    lastError: string | null
    summary: string | null
  }>
  staleSampleTruncated?: boolean
}

type BullmqPurgeResult = {
  ok: true
  dryRun: boolean
  totalCompleted: number
  totalFailed: number
  totalKeys: number
  totalCleaned?: number
  queues: Record<string, { completed: number; failed: number }>
}

interface DeveloperToolsSectionProps {
  excludeInternalIpsFromAnalytics: boolean
  setExcludeInternalIpsFromAnalytics: (value: boolean) => void
  uploadChunkSizeMB: number | ''
  setUploadChunkSizeMB: (value: number | '') => void
  downloadChunkSizeMB: number | ''
  setDownloadChunkSizeMB: (value: number | '') => void
  show: boolean
  setShow: (value: boolean) => void
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  const rounded = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[unitIndex]}`
}

export function DeveloperToolsSection({
  excludeInternalIpsFromAnalytics,
  setExcludeInternalIpsFromAnalytics,
  uploadChunkSizeMB,
  setUploadChunkSizeMB,
  downloadChunkSizeMB,
  setDownloadChunkSizeMB,
  show,
  setShow,
}: DeveloperToolsSectionProps) {
  const [orphanProjectFilesLoading, setOrphanProjectFilesLoading] = useState(false)
  const [orphanProjectFilesResult, setOrphanProjectFilesResult] = useState<OrphanProjectFileCleanupResult | null>(null)
  const [orphanProjectFilesError, setOrphanProjectFilesError] = useState<string | null>(null)

  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogResult, setBacklogResult] = useState<NotificationBacklogResult | null>(null)
  const [backlogError, setBacklogError] = useState<string | null>(null)

  const [bullmqPurgeLoading, setBullmqPurgeLoading] = useState(false)
  const [bullmqPurgeResult, setBullmqPurgeResult] = useState<BullmqPurgeResult | null>(null)
  const [bullmqPurgeError, setBullmqPurgeError] = useState<string | null>(null)

  async function runBullmqPurge(dryRun: boolean) {
    setBullmqPurgeLoading(true)
    setBullmqPurgeError(null)
    try {
      const res = await apiPost('/api/settings/purge-bullmq-jobs', { dryRun })
      setBullmqPurgeResult(res as BullmqPurgeResult)
    } catch (e: any) {
      setBullmqPurgeError(e?.message || 'Failed to run BullMQ purge')
    } finally {
      setBullmqPurgeLoading(false)
    }
  }

  async function runBacklogPurge(dryRun: boolean) {
    setBacklogLoading(true)
    setBacklogError(null)
    try {
      const res = await apiPost('/api/settings/purge-notification-backlog', { dryRun })
      setBacklogResult(res as NotificationBacklogResult)
    } catch (e: any) {
      setBacklogError(e?.message || 'Failed to run purge')
    } finally {
      setBacklogLoading(false)
    }
  }

  const orphanProjectFilesSummary = useMemo(() => {
    if (!orphanProjectFilesResult) return null
    const line1 = `${orphanProjectFilesResult.orphanFiles} orphan files (${formatBytes(orphanProjectFilesResult.orphanFileBytes)})`
    const line2 = `${orphanProjectFilesResult.scannedFiles} files scanned across ${orphanProjectFilesResult.scannedProjects ?? orphanProjectFilesResult.scannedDirectories ?? orphanProjectFilesResult.scannedProjectDirectories} project${(orphanProjectFilesResult.scannedProjects ?? 1) === 1 ? '' : 's'}`
    return { line1, line2 }
  }, [orphanProjectFilesResult])

  async function runOrphanProjectFilesCleanup(dryRun: boolean) {
    setOrphanProjectFilesLoading(true)
    setOrphanProjectFilesError(null)

    try {
      const res = await apiPost('/api/settings/cleanup-orphan-project-files', { dryRun })
      setOrphanProjectFilesResult(res as OrphanProjectFileCleanupResult)
    } catch (e: any) {
      setOrphanProjectFilesError(e?.message || 'Failed to run orphan file cleanup')
    } finally {
      setOrphanProjectFilesLoading(false)
    }
  }

  function formatBacklogEntry(entry: NonNullable<NotificationBacklogResult['staleSample']>[number]) {
    const createdAt = new Date(entry.createdAt).toLocaleString()
    const projectLabel = entry.projectTitle || entry.projectId || 'No project'
    const pendingTargets = entry.pendingTargets.length ? entry.pendingTargets.join(',') : 'none'
    const summary = entry.summary ? ` | ${entry.summary}` : ''
    const lastError = entry.lastError ? ` | lastError=${entry.lastError}` : ''
    return `${createdAt} | ${entry.type} | project=${projectLabel} | pending=${pendingTargets} | attempts=c${entry.attempts.clients}/a${entry.attempts.admins}${summary}${lastError}`
  }

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setShow(!show)}>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Developer Tools</CardTitle>
            <CardDescription>
              Maintenance and diagnostic actions (safe, allow-listed)
            </CardDescription>
          </div>
          {show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>

      {show && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 flex-1 min-w-0">
                <Label htmlFor="excludeInternalIpsFromAnalytics">Exclude internal/admin IPs from analytics</Label>
                <p className="text-xs text-muted-foreground">
                  Leave this on for normal use. Turn it off temporarily when you need to test project, quote, or invoice analytics from an internal/admin network.
                </p>
              </div>
              <Switch
                id="excludeInternalIpsFromAnalytics"
                checked={excludeInternalIpsFromAnalytics}
                onCheckedChange={setExcludeInternalIpsFromAnalytics}
              />
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="space-y-0.5">
              <Label>Transfer tuning</Label>
              <p className="text-xs text-muted-foreground">
                Controls the TUS upload PATCH size and the server-side file read/download chunk size. Changes apply after saving settings.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="uploadChunkSizeMB">Upload chunk size (MB)</Label>
                <Input
                  id="uploadChunkSizeMB"
                  type="number"
                  min={MIN_UPLOAD_CHUNK_SIZE_MB}
                  max={MAX_UPLOAD_CHUNK_SIZE_MB}
                  step={1}
                  value={uploadChunkSizeMB}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setUploadChunkSizeMB(nextValue === '' ? '' : Number(nextValue))
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Allowed range: {MIN_UPLOAD_CHUNK_SIZE_MB}-{MAX_UPLOAD_CHUNK_SIZE_MB} MB.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="downloadChunkSizeMB">Download chunk size (MB)</Label>
                <Input
                  id="downloadChunkSizeMB"
                  type="number"
                  min={MIN_DOWNLOAD_CHUNK_SIZE_MB}
                  max={MAX_DOWNLOAD_CHUNK_SIZE_MB}
                  step={1}
                  value={downloadChunkSizeMB}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setDownloadChunkSizeMB(nextValue === '' ? '' : Number(nextValue))
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Allowed range: {MIN_DOWNLOAD_CHUNK_SIZE_MB}-{MAX_DOWNLOAD_CHUNK_SIZE_MB} MB.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Orphan project files cleanup</Label>
                <p className="text-xs text-muted-foreground">
                  Scans project storage for files that are no longer referenced by the database
                  (videos, previews, timeline sprites, album photos, ZIPs, comment uploads, project files, and imported emails).
                  Run a dry run first to preview impact.
                </p>

                {orphanProjectFilesError ? (
                  <p className="text-xs text-destructive">{orphanProjectFilesError}</p>
                ) : null}

                {orphanProjectFilesSummary ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{orphanProjectFilesSummary.line1}</p>
                    <p className="text-xs text-muted-foreground">{orphanProjectFilesSummary.line2}</p>
                    {orphanProjectFilesResult?.deleted ? (
                      <p className="text-xs text-muted-foreground">
                        Deleted: {orphanProjectFilesResult.deleted.filesDeleted} files
                        {orphanProjectFilesResult.deleted.filesFailed ? ` (${orphanProjectFilesResult.deleted.filesFailed} file deletes failed)` : ''}
                        {orphanProjectFilesResult.deleted.emptyDirsPruned ? `; pruned ${orphanProjectFilesResult.deleted.emptyDirsPruned} empty directories` : ''}
                      </p>
                    ) : null}
                    {orphanProjectFilesResult?.errors?.length ? (
                      <p className="text-xs text-muted-foreground">Errors: {orphanProjectFilesResult.errors.length}</p>
                    ) : null}

                    {orphanProjectFilesResult?.sample ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show sample paths
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Orphan paths (first 20)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {orphanProjectFilesResult.sample.orphanPaths.join('\n') || 'None'}
                            </pre>
                          </div>

                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Project IDs</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {orphanProjectFilesResult.sample.projectIds.join('\n') || 'None'}
                            </pre>
                          </div>

                          {orphanProjectFilesResult?.errors?.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">Errors (first 20)</div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {orphanProjectFilesResult.errors
                                  .slice(0, 20)
                                  .map((e) => `${e.path}: ${e.error}`)
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
                  disabled={orphanProjectFilesLoading}
                  onClick={() => void runOrphanProjectFilesCleanup(true)}
                >
                  {orphanProjectFilesLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={orphanProjectFilesLoading}
                  onClick={() => {
                    if (!confirm('Delete orphan project files from storage? This cannot be undone.')) return
                    void runOrphanProjectFilesCleanup(false)
                  }}
                >
                  {orphanProjectFilesLoading ? 'Running…' : 'Clean up'}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Notification queue backlog</Label>
                <p className="text-xs text-muted-foreground">
                  Finds unsent notification queue entries older than 7 days and marks them as already sent,
                  so they are never delivered. Use this after upgrades or configuration changes that left
                  a backlog of stale queued notifications. Run a dry-run first to see what would be dismissed.
                </p>

                {backlogError ? (
                  <p className="text-xs text-destructive">{backlogError}</p>
                ) : null}

                {backlogResult ? (
                  <div className="mt-2 space-y-1">
                    {backlogResult.dryRun ? (
                      <>
                        <p className="text-xs text-muted-foreground">Total unsent entries: {backlogResult.totalUnsent}</p>
                        <p className="text-xs text-muted-foreground">Stale (&gt;7 days, would be dismissed): {backlogResult.staleCount}</p>
                        <p className="text-xs text-muted-foreground">Recent (≤7 days, would be kept): {backlogResult.recentCount}</p>
                        {backlogResult.oldestCreatedAt ? (
                          <p className="text-xs text-muted-foreground">Oldest entry: {new Date(backlogResult.oldestCreatedAt).toLocaleDateString()}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">Dismissed: {backlogResult.dismissed} stale entries</p>
                        <p className="text-xs text-muted-foreground">Recent entries kept: {backlogResult.recentCount}</p>
                      </>
                    )}

                    {backlogResult.staleSample?.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show stale notifications{backlogResult.staleSampleTruncated ? ' (first 50)' : ''}
                        </summary>
                        <div className="mt-2">
                          <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                            {backlogResult.staleSample.map((entry) => formatBacklogEntry(entry)).join('\n')}
                          </pre>
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
                  disabled={backlogLoading}
                  onClick={() => void runBacklogPurge(true)}
                >
                  {backlogLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={backlogLoading}
                  onClick={() => {
                    if (!confirm('Mark all unsent notification queue entries older than 7 days as already sent? They will not be delivered.')) return
                    void runBacklogPurge(false)
                  }}
                >
                  {backlogLoading ? 'Running…' : 'Dismiss backlog'}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Purge stale BullMQ jobs</Label>
                <p className="text-xs text-muted-foreground">
                  Removes completed (older than 1 hour) and failed (older than 24 hours) jobs from all BullMQ
                  queues in Redis. Use this to reclaim Redis memory after key bloat or if Redis AOF fsync
                  warnings appear. Run a dry-run first to preview counts.
                </p>

                {bullmqPurgeError ? (
                  <p className="text-xs text-destructive">{bullmqPurgeError}</p>
                ) : null}

                {bullmqPurgeResult ? (
                  <div className="mt-2 space-y-1">
                    {bullmqPurgeResult.dryRun ? (
                      <>
                        <p className="text-xs text-muted-foreground">Completed jobs: {bullmqPurgeResult.totalCompleted}</p>
                        <p className="text-xs text-muted-foreground">Failed jobs: {bullmqPurgeResult.totalFailed}</p>
                        <p className="text-xs text-muted-foreground">Total stale job keys: {bullmqPurgeResult.totalKeys}</p>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Cleaned {bullmqPurgeResult.totalCleaned ?? 0} stale job keys from Redis
                      </p>
                    )}

                    {Object.keys(bullmqPurgeResult.queues).length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show per-queue breakdown
                        </summary>
                        <div className="mt-2">
                          <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                            {Object.entries(bullmqPurgeResult.queues)
                              .map(([name, counts]) => `${name}: ${counts.completed} completed, ${counts.failed} failed`)
                              .join('\n')}
                          </pre>
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
                  disabled={bullmqPurgeLoading}
                  onClick={() => void runBullmqPurge(true)}
                >
                  {bullmqPurgeLoading ? 'Running\u2026' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={bullmqPurgeLoading}
                  onClick={() => {
                    if (!confirm('Purge all stale completed and failed BullMQ jobs from Redis? Active and waiting jobs are not affected.')) return
                    void runBullmqPurge(false)
                  }}
                >
                  {bullmqPurgeLoading ? 'Running\u2026' : 'Purge jobs'}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
