import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { apiPost } from '@/lib/api-client'

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

type ProjectStorageYearMonthMigrationResult = {
  ok: true
  dryRun: boolean
  projectsChecked: number
  alreadyInYearMonthFolder: number
  movedFromLegacyRoot: number
  movedFromClosedFolder: number
  stubsCreatedOrUpdated: number
  closedFoldersPruned?: number
  sample?: {
    movedProjectIds: string[]
    missingProjectIds: string[]
    movedProjects?: Array<{ id: string; title: string }>
    missingProjects?: Array<{ id: string; title: string }>
  }
  errors?: Array<{ projectId?: string; path?: string; error: string }>
}

interface DeveloperToolsSectionProps {
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
  onRecalculateProjectDataTotals,
  recalculateProjectDataTotalsLoading,
  recalculateProjectDataTotalsResult,
  show,
  setShow,
}: DeveloperToolsSectionProps) {
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<OrphanCommentCleanupResult | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)

  const [projectStorageMigrationLoading, setProjectStorageMigrationLoading] = useState(false)
  const [projectStorageMigrationResult, setProjectStorageMigrationResult] = useState<ProjectStorageYearMonthMigrationResult | null>(null)
  const [projectStorageMigrationError, setProjectStorageMigrationError] = useState<string | null>(null)

  const cleanupSummary = useMemo(() => {
    if (!cleanupResult) return null
    const line1 = `${cleanupResult.orphanComments} orphan comments, ${cleanupResult.orphanCommentFiles} files (${formatBytes(cleanupResult.orphanCommentFileBytes)})`
    const line2 = `${cleanupResult.uniqueStoragePaths} unique storage paths (limit ${cleanupResult.limit})`
    return { line1, line2 }
  }, [cleanupResult])

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

  async function runProjectStorageYearMonthMigration(dryRun: boolean) {
    setProjectStorageMigrationLoading(true)
    setProjectStorageMigrationError(null)

    try {
      const res = await apiPost('/api/settings/migrate-project-storage-yearmonth', { dryRun })
      setProjectStorageMigrationResult(res as ProjectStorageYearMonthMigrationResult)
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
                <Label>Project storage migration (YYYY-MM)</Label>
                <p className="text-xs text-muted-foreground">
                  Moves existing projects into <span className="font-mono">projects/YYYY-MM/&lt;projectId&gt;</span> based on their
                  created date, and ensures a redirect stub exists at <span className="font-mono">projects/&lt;projectId&gt;</span> so legacy
                  storage paths still work.
                  Run a dry-run first to preview changes.
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
                      Already in YYYY-MM: {projectStorageMigrationResult.alreadyInYearMonthFolder}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Moved: {projectStorageMigrationResult.movedFromLegacyRoot} from legacy root; {projectStorageMigrationResult.movedFromClosedFolder} from closed folder
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Redirect stubs created/updated: {projectStorageMigrationResult.stubsCreatedOrUpdated}
                      {projectStorageMigrationResult.closedFoldersPruned !== undefined ? `; closed folders pruned: ${projectStorageMigrationResult.closedFoldersPruned}` : ''}
                    </p>
                    {projectStorageMigrationResult.errors?.length ? (
                      <p className="text-xs text-muted-foreground">Errors: {projectStorageMigrationResult.errors.length}</p>
                    ) : null}

                    {projectStorageMigrationResult.sample ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show sample projects
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Moved projects (first 10)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {(projectStorageMigrationResult.sample.movedProjects?.length
                                ? projectStorageMigrationResult.sample.movedProjects.map((p) => `${p.id}\t${p.title}`)
                                : projectStorageMigrationResult.sample.movedProjectIds
                              ).join('\n')}
                            </pre>
                          </div>
                          <div>
                            <div className="text-[11px] font-medium text-muted-foreground">Missing projects (first 10)</div>
                            <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                              {(projectStorageMigrationResult.sample.missingProjects?.length
                                ? projectStorageMigrationResult.sample.missingProjects.map((p) => `${p.id}\t${p.title}`)
                                : projectStorageMigrationResult.sample.missingProjectIds
                              ).join('\n')}
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
                    if (!confirm('Move project folders into projects/YYYY-MM/<projectId>? This cannot be undone.')) return
                    void runProjectStorageYearMonthMigration(false)
                  }}
                >
                  {projectStorageMigrationLoading ? 'Running…' : 'Migrate'}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
