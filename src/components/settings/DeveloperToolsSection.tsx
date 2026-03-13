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

type OrphanCommentCleanupResult = {
  ok: true
  dryRun: boolean
  limit: number
  orphanComments: number
  orphanCommentFiles: number
  orphanCommentFileBytes: number
  uniqueStoragePaths: number
  sample?: {
    commentIds: string[]
    projectIds: string[]
    videoIds: string[]
  }
  deleted?: {
    comments: number
    filesDeleted: number
    filesFailed: number
  }
  errors?: Array<{ storagePath: string; error: string }>
}

type OrphanProjectFileCleanupResult = {
  ok: true
  dryRun: boolean
  scannedProjectDirectories: number
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

type ProjectStorageMigrationResult = {
  ok: true
  dryRun: boolean
  projectsChecked: number
  projectsMigrated: number
  projectsAlreadyCanonical: number
  projectsWithoutClient: number
  projectsWithoutExistingRoot: number
  projectRootsMoved: number
  videoFoldersNormalized: number
  assetFilesNormalized: number
  albumFoldersNormalized: number
  recordsUpdated: number
  legacyFolderCleanup?: {
    removed: string[]
    skippedNonEmpty: boolean
  }
  sample?: {
    migratedProjects: Array<{ id: string; title: string; targetPath: string }>
    skippedProjects: Array<{ id: string; title: string; reason: string }>
  }
  errors?: Array<{ projectId?: string; path?: string; error: string }>
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

type MissingThumbnailRepairResult = {
  ok: true
  dryRun: boolean
  videosChecked: number
  videosEligible: number
  queued?: number
  skippedClosedProjects: number
  skippedCustomThumbnails: number
  sample?: Array<{ videoId: string; projectId: string; projectTitle: string; videoName: string; versionLabel: string; reason: string }>
}

interface DeveloperToolsSectionProps {
  excludeInternalIpsFromAnalytics: boolean
  setExcludeInternalIpsFromAnalytics: (value: boolean) => void
  uploadChunkSizeMB: number | ''
  setUploadChunkSizeMB: (value: number | '') => void
  downloadChunkSizeMB: number | ''
  setDownloadChunkSizeMB: (value: number | '') => void
  onRecalculateProjectDataTotals?: () => void
  recalculateProjectDataTotalsLoading?: boolean
  recalculateProjectDataTotalsResult?: string | null
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
  onRecalculateProjectDataTotals,
  recalculateProjectDataTotalsLoading,
  recalculateProjectDataTotalsResult,
  show,
  setShow,
}: DeveloperToolsSectionProps) {
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<OrphanCommentCleanupResult | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)

  const [orphanProjectFilesLoading, setOrphanProjectFilesLoading] = useState(false)
  const [orphanProjectFilesResult, setOrphanProjectFilesResult] = useState<OrphanProjectFileCleanupResult | null>(null)
  const [orphanProjectFilesError, setOrphanProjectFilesError] = useState<string | null>(null)

  const [projectStorageMigrationLoading, setProjectStorageMigrationLoading] = useState(false)
  const [projectStorageMigrationResult, setProjectStorageMigrationResult] = useState<ProjectStorageMigrationResult | null>(null)
  const [projectStorageMigrationError, setProjectStorageMigrationError] = useState<string | null>(null)

  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogResult, setBacklogResult] = useState<NotificationBacklogResult | null>(null)
  const [backlogError, setBacklogError] = useState<string | null>(null)

  const [bullmqPurgeLoading, setBullmqPurgeLoading] = useState(false)
  const [bullmqPurgeResult, setBullmqPurgeResult] = useState<BullmqPurgeResult | null>(null)
  const [bullmqPurgeError, setBullmqPurgeError] = useState<string | null>(null)

  const [closedPreviewsLoading, setClosedPreviewsLoading] = useState(false)
  const [closedPreviewsResult, setClosedPreviewsResult] = useState<ClosedProjectPreviewCleanupResult | null>(null)
  const [closedPreviewsError, setClosedPreviewsError] = useState<string | null>(null)

  const [missingThumbnailLoading, setMissingThumbnailLoading] = useState(false)
  const [missingThumbnailResult, setMissingThumbnailResult] = useState<MissingThumbnailRepairResult | null>(null)
  const [missingThumbnailError, setMissingThumbnailError] = useState<string | null>(null)

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

  async function runMissingThumbnailRepair(dryRun: boolean) {
    setMissingThumbnailLoading(true)
    setMissingThumbnailError(null)
    try {
      const res = await apiPost('/api/settings/regenerate-missing-thumbnails', { dryRun })
      setMissingThumbnailResult(res as MissingThumbnailRepairResult)
    } catch (e: any) {
      setMissingThumbnailError(e?.message || 'Failed to queue thumbnail regeneration')
    } finally {
      setMissingThumbnailLoading(false)
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

  const cleanupSummary = useMemo(() => {
    if (!cleanupResult) return null
    const line1 = `${cleanupResult.orphanComments} orphan comments, ${cleanupResult.orphanCommentFiles} files (${formatBytes(cleanupResult.orphanCommentFileBytes)})`
    const line2 = `${cleanupResult.uniqueStoragePaths} unique storage paths (limit ${cleanupResult.limit})`
    return { line1, line2 }
  }, [cleanupResult])

  const orphanProjectFilesSummary = useMemo(() => {
    if (!orphanProjectFilesResult) return null
    const line1 = `${orphanProjectFilesResult.orphanFiles} orphan files (${formatBytes(orphanProjectFilesResult.orphanFileBytes)})`
    const line2 = `${orphanProjectFilesResult.scannedFiles} files scanned across ${orphanProjectFilesResult.scannedProjectDirectories} project folders`
    return { line1, line2 }
  }, [orphanProjectFilesResult])

  async function runOrphanCleanup(dryRun: boolean) {
    setCleanupLoading(true)
    setCleanupError(null)

    try {
      const res = await apiPost('/api/settings/cleanup-orphan-comments', { dryRun, limit: 5000 })
      setCleanupResult(res as OrphanCommentCleanupResult)
    } catch (e: any) {
      setCleanupError(e?.message || 'Failed to run cleanup')
    } finally {
      setCleanupLoading(false)
    }
  }

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

  async function runProjectStorageYearMonthMigration(dryRun: boolean) {
    setProjectStorageMigrationLoading(true)
    setProjectStorageMigrationError(null)

    try {
      const res = await apiPost('/api/settings/migrate-project-storage-yearmonth', { dryRun })
      setProjectStorageMigrationResult(res as ProjectStorageMigrationResult)
    } catch (e: any) {
      setProjectStorageMigrationError(e?.message || 'Failed to run migration')
    } finally {
      setProjectStorageMigrationLoading(false)
    }
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
                <Label>Project Data totals</Label>
                <p className="text-xs text-muted-foreground">
                  Recalculate totals from the database and the project folder on disk (videos, photos, ZIP artifacts, previews, etc).
                  Use this after upgrades or if totals look incorrect.
                </p>
                {recalculateProjectDataTotalsResult ? (
                  <p className="text-xs text-muted-foreground">{recalculateProjectDataTotalsResult}</p>
                ) : null}
              </div>

              <Button
                type="button"
                variant="secondary"
                className="flex-shrink-0"
                disabled={!onRecalculateProjectDataTotals || recalculateProjectDataTotalsLoading}
                onClick={() => onRecalculateProjectDataTotals?.()}
              >
                {recalculateProjectDataTotalsLoading ? 'Queuing…' : 'Recalculate now'}
              </Button>
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Orphan Comments cleanup</Label>
                <p className="text-xs text-muted-foreground">
                  Finds share-page comments whose linked video no longer exists (historical data created before FK enforcement).
                  Run a dry-run first to preview impact.
                </p>

                {cleanupError ? (
                  <p className="text-xs text-destructive">{cleanupError}</p>
                ) : null}

                {cleanupSummary ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{cleanupSummary.line1}</p>
                    <p className="text-xs text-muted-foreground">{cleanupSummary.line2}</p>
                    {cleanupResult?.deleted ? (
                      <p className="text-xs text-muted-foreground">
                        Deleted: {cleanupResult.deleted.comments} comments, {cleanupResult.deleted.filesDeleted} files
                        {cleanupResult.deleted.filesFailed ? ` (${cleanupResult.deleted.filesFailed} file deletes failed)` : ''}
                      </p>
                    ) : null}
                    {cleanupResult?.errors?.length ? (
                      <p className="text-xs text-muted-foreground">File delete errors: {cleanupResult.errors.length}</p>
                    ) : null}

                    {cleanupResult?.sample ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show sample IDs
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Comment IDs</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {cleanupResult.sample.commentIds.join('\n')}
                            </pre>
                          </div>

                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Project IDs</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {cleanupResult.sample.projectIds.join('\n')}
                            </pre>
                          </div>

                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Video IDs</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {cleanupResult.sample.videoIds.join('\n')}
                            </pre>
                          </div>

                          {cleanupResult?.errors?.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">File delete errors (first 20)</div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {cleanupResult.errors
                                  .slice(0, 20)
                                  .map((e) => `${e.storagePath}: ${e.error}`)
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
                  disabled={cleanupLoading}
                  onClick={() => void runOrphanCleanup(true)}
                >
                  {cleanupLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={cleanupLoading}
                  onClick={() => {
                    if (!confirm('Delete orphan comments and their uploaded files? This cannot be undone.')) return
                    void runOrphanCleanup(false)
                  }}
                >
                  {cleanupLoading ? 'Running…' : 'Clean up'}
                </Button>
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
                <Label>Project storage normalization</Label>
                <p className="text-xs text-muted-foreground">
                  Normalizes existing local storage into the canonical client/project layout under
                  <span className="font-mono"> clients/&lt;client&gt;/projects/&lt;project&gt; </span>
                  and rehomes video and album folders to use their names instead of legacy IDs or date-based roots.
                  Run a dry-run first to preview changes before applying them.
                </p>

                {projectStorageMigrationError ? (
                  <p className="text-xs text-destructive">{projectStorageMigrationError}</p>
                ) : null}

                {projectStorageMigrationResult ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Projects checked: {projectStorageMigrationResult.projectsChecked}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Migrated: {projectStorageMigrationResult.projectsMigrated}; already canonical: {projectStorageMigrationResult.projectsAlreadyCanonical}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Skipped without client: {projectStorageMigrationResult.projectsWithoutClient}; missing on disk: {projectStorageMigrationResult.projectsWithoutExistingRoot}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Project roots moved: {projectStorageMigrationResult.projectRootsMoved}; video folders normalized: {projectStorageMigrationResult.videoFoldersNormalized}; album folders normalized: {projectStorageMigrationResult.albumFoldersNormalized}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Asset files normalized: {projectStorageMigrationResult.assetFilesNormalized}; records updated: {projectStorageMigrationResult.recordsUpdated}
                    </p>
                    {projectStorageMigrationResult.errors?.length ? (
                      <p className="text-xs text-muted-foreground">Errors: {projectStorageMigrationResult.errors.length}</p>
                    ) : null}
                    {projectStorageMigrationResult.legacyFolderCleanup ? (
                      <p className="text-xs text-muted-foreground">
                        Legacy projects/ cleanup: {projectStorageMigrationResult.legacyFolderCleanup.removed.length
                          ? `removed ${projectStorageMigrationResult.legacyFolderCleanup.removed.join(', ')}`
                          : 'nothing to remove'}
                        {projectStorageMigrationResult.legacyFolderCleanup.skippedNonEmpty
                          ? ' (some folders still contain data files)'
                          : ''}
                      </p>
                    ) : null}

                    {projectStorageMigrationResult.sample ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show sample projects
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Migrated projects (first 10)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {projectStorageMigrationResult.sample.migratedProjects
                                .map((p) => `${p.id}\t${p.title}\t${p.targetPath}`)
                                .join('\n') || 'None'}
                            </pre>
                          </div>
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Skipped projects (first 10)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {projectStorageMigrationResult.sample.skippedProjects
                                .map((p) => `${p.id}\t${p.title}\t${p.reason}`)
                                .join('\n') || 'None'}
                            </pre>
                          </div>

                          {projectStorageMigrationResult.errors?.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">Errors (first 20)</div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {projectStorageMigrationResult.errors
                                  .slice(0, 20)
                                  .map((e) => `${e.projectId ? `${e.projectId}: ` : ''}${e.path ? `${e.path}: ` : ''}${e.error}`)
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
                  disabled={projectStorageMigrationLoading}
                  onClick={() => void runProjectStorageYearMonthMigration(true)}
                >
                  {projectStorageMigrationLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={projectStorageMigrationLoading}
                  onClick={() => {
                    if (!confirm('Normalize project storage into clients/<client>/projects/<project>? This cannot be undone.')) return
                    void runProjectStorageYearMonthMigration(false)
                  }}
                >
                  {projectStorageMigrationLoading ? 'Running…' : 'Migrate'}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Delete previews for closed projects</Label>
                <p className="text-xs text-muted-foreground">
                  Finds all CLOSED projects that still have preview files (480p, 720p, 1080p) or timeline sprite
                  directories on disk, and deletes them to reclaim storage.
                  Database fields are cleared so previews will regenerate if the project is re-opened.
                  Run a dry-run first to preview impact.
                </p>

                {closedPreviewsError ? (
                  <p className="text-xs text-destructive">{closedPreviewsError}</p>
                ) : null}

                {closedPreviewsResult ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Closed projects: {closedPreviewsResult.closedProjects} total, {closedPreviewsResult.projectsWithPreviews} with previews
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Videos with previews: {closedPreviewsResult.videosWithPreviews}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Preview files: {closedPreviewsResult.previewFiles}; timeline sprite dirs: {closedPreviewsResult.timelineDirs}
                    </p>
                    {closedPreviewsResult.deleted ? (
                      <p className="text-xs text-muted-foreground">
                        Deleted: {closedPreviewsResult.deleted.previewFiles} preview files
                        {closedPreviewsResult.deleted.previewFilesFailed ? ` (${closedPreviewsResult.deleted.previewFilesFailed} failed)` : ''}
                        , {closedPreviewsResult.deleted.timelineDirs} timeline dirs
                        {closedPreviewsResult.deleted.timelineDirsFailed ? ` (${closedPreviewsResult.deleted.timelineDirsFailed} failed)` : ''}
                      </p>
                    ) : null}
                    {closedPreviewsResult.errors?.length ? (
                      <p className="text-xs text-muted-foreground">Errors: {closedPreviewsResult.errors.length}</p>
                    ) : null}

                    {closedPreviewsResult.sample?.projects?.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show affected projects
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Affected projects (first 10)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {closedPreviewsResult.sample.projects
                                .map(p => `${p.id}\t${p.title} (${p.videos} video${p.videos !== 1 ? 's' : ''})`)
                                .join('\n')}
                            </pre>
                          </div>

                          {closedPreviewsResult.errors?.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">Errors (first 20)</div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {closedPreviewsResult.errors
                                  .slice(0, 20)
                                  .map(e => `${e.projectId}: ${e.path}: ${e.error}`)
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
                  {closedPreviewsLoading ? 'Running\u2026' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={closedPreviewsLoading}
                  onClick={() => {
                    if (!confirm('Delete all preview files and timeline sprites for CLOSED projects? This cannot be undone.')) return
                    void runClosedPreviewsCleanup(false)
                  }}
                >
                  {closedPreviewsLoading ? 'Running\u2026' : 'Delete previews'}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Regenerate missing video thumbnails</Label>
                <p className="text-xs text-muted-foreground">
                  Finds READY and ERROR videos whose system thumbnail is missing on disk or unset, then queues
                  thumbnail-only repair jobs. Existing previews stay untouched. Custom asset-based thumbnails are skipped.
                  Run a dry run first to preview impact.
                </p>

                {missingThumbnailError ? (
                  <p className="text-xs text-destructive">{missingThumbnailError}</p>
                ) : null}

                {missingThumbnailResult ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Videos checked: {missingThumbnailResult.videosChecked}; eligible: {missingThumbnailResult.videosEligible}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Skipped custom thumbnails: {missingThumbnailResult.skippedCustomThumbnails}; skipped closed-project videos: {missingThumbnailResult.skippedClosedProjects}
                    </p>
                    {!missingThumbnailResult.dryRun ? (
                      <p className="text-xs text-muted-foreground">Queued: {missingThumbnailResult.queued ?? 0}</p>
                    ) : null}

                    {missingThumbnailResult.sample?.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show affected videos
                        </summary>
                        <div className="mt-2">
                          <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                            {missingThumbnailResult.sample
                              .map((video) => `${video.projectId}\t${video.projectTitle}\t${video.videoName}\t${video.versionLabel}\t${video.reason}`)
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
                  disabled={missingThumbnailLoading}
                  onClick={() => void runMissingThumbnailRepair(true)}
                >
                  {missingThumbnailLoading ? 'Running…' : 'Dry run'}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  disabled={missingThumbnailLoading}
                  onClick={() => {
                    if (!confirm('Queue thumbnail-only repair jobs for all videos with missing system thumbnails?')) return
                    void runMissingThumbnailRepair(false)
                  }}
                >
                  {missingThumbnailLoading ? 'Running…' : 'Queue repairs'}
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
