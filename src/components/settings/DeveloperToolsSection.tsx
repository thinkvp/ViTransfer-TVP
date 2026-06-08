import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { apiFetch, apiPost } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
  /** DB records whose file is absent from storage */
  missingFiles: number
  missingFileSample?: {
    paths: string[]
  }
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

type LocalToS3DryRunResult = {
  ok: true
  discoveredPaths: number
  existingLocalFiles: number
  missingLocalFiles: number
  totalBytes: number
  alreadyInS3?: number
  wouldCopy?: number
  wouldCopyBytes?: number
  sampleKeys: string[]
  missingKeys: string[]
}

type LocalToS3StatusResult = {
  active: boolean
  run: {
    id: string
    status: 'PREPARING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
    startedAt: string
    finishedAt: string | null
    currentKey: string | null
    filesTotal: number
    filesProcessed: number
    filesCopied: number
    filesSkipped: number
    filesFailed: number
    bytesTotal: number
    bytesCopied: number
    errors: Array<{ key: string; error: string }>
    speedBytesPerSecond: number
    etaSeconds: number | null
    progressPercent: number
    overwriteExisting: boolean
    concurrency: number
    multipartThresholdMB: number
    multipartPartSizeMB: number
    multipartQueueSize: number
  } | null
}

type NormalizeAccountingAttachmentPathsResult = {
  ok: true
  dryRun: boolean
  legacyRows: number
  normalizedRows: number
  invalidRows: number
  sample: Array<{
    id: string
    from: string
    to: string | null
    originalName: string
    error: string | null
  }>
  sampleTruncated: boolean
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
  hideCollapse?: boolean
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

function formatDuration(totalSeconds: number | null) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '--'
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = seconds % 60
  if (minutes < 60) return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
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
  hideCollapse,
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

  const [s3Endpoint, setS3Endpoint] = useState('')
  const [s3Bucket, setS3Bucket] = useState('')
  const [s3Region, setS3Region] = useState('auto')
  const [s3AccessKeyId, setS3AccessKeyId] = useState('')
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('')
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(true)
  const [s3Concurrency, setS3Concurrency] = useState<number | ''>(3)
  const [s3OverwriteExisting, setS3OverwriteExisting] = useState(false)
  const [s3MultipartThresholdMB, setS3MultipartThresholdMB] = useState<number | ''>(64)
  const [s3MultipartPartSizeMB, setS3MultipartPartSizeMB] = useState<number | ''>(64)
  const [s3MultipartQueueSize, setS3MultipartQueueSize] = useState<number | ''>(4)

  const [s3ValidateLoading, setS3ValidateLoading] = useState(false)
  const [s3ValidateMessage, setS3ValidateMessage] = useState<string | null>(null)
  const [s3DryRunLoading, setS3DryRunLoading] = useState(false)
  const [s3DryRunResult, setS3DryRunResult] = useState<LocalToS3DryRunResult | null>(null)
  const [s3MigrationLoading, setS3MigrationLoading] = useState(false)
  const [s3MigrationMessage, setS3MigrationMessage] = useState<string | null>(null)
  const [s3Status, setS3Status] = useState<LocalToS3StatusResult | null>(null)

  const [accountingPathRepairLoading, setAccountingPathRepairLoading] = useState(false)
  const [accountingPathRepairResult, setAccountingPathRepairResult] = useState<NormalizeAccountingAttachmentPathsResult | null>(null)
  const [accountingPathRepairError, setAccountingPathRepairError] = useState<string | null>(null)

  const [pendingS3Start, setPendingS3Start] = useState(false)
  const [pendingOrphanCleanup, setPendingOrphanCleanup] = useState(false)
  const [pendingBacklogPurge, setPendingBacklogPurge] = useState(false)
  const [pendingBullmqPurge, setPendingBullmqPurge] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function refreshStatus() {
      try {
        const response = await apiFetch('/api/settings/migrate-local-to-s3/status')
        if (!response.ok) return
        const data = (await response.json()) as LocalToS3StatusResult
        if (!cancelled) setS3Status(data)
      } catch {
        // ignore polling errors
      }
    }

    void refreshStatus()
    const intervalMs = s3Status?.active ? 2000 : 10000
    const timer = setInterval(() => {
      void refreshStatus()
    }, intervalMs)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [s3Status?.active])

  async function runS3Validate() {
    setS3ValidateLoading(true)
    setS3ValidateMessage(null)
    try {
      await apiPost('/api/settings/migrate-local-to-s3/validate', {
        endpoint: s3Endpoint,
        bucket: s3Bucket,
        region: s3Region,
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
        forcePathStyle: s3ForcePathStyle,
      })
      setS3ValidateMessage('S3 configuration is valid.')
    } catch (error: any) {
      setS3ValidateMessage(error?.message || 'Validation failed')
    } finally {
      setS3ValidateLoading(false)
    }
  }

  async function runS3DryRun() {
    setS3DryRunLoading(true)
    setS3MigrationMessage(null)
    try {
      const result = await apiPost('/api/settings/migrate-local-to-s3/dry-run', {
        endpoint: s3Endpoint,
        bucket: s3Bucket,
        region: s3Region,
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
        forcePathStyle: s3ForcePathStyle,
      })
      setS3DryRunResult(result as LocalToS3DryRunResult)
    } catch (error: any) {
      setS3MigrationMessage(error?.message || 'Dry run failed')
    } finally {
      setS3DryRunLoading(false)
    }
  }

  async function runS3Start() {
    setS3MigrationLoading(true)
    setS3MigrationMessage(null)
    try {
      const result = await apiPost('/api/settings/migrate-local-to-s3/start', {
        endpoint: s3Endpoint,
        bucket: s3Bucket,
        region: s3Region,
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
        forcePathStyle: s3ForcePathStyle,
        concurrency: typeof s3Concurrency === 'number' ? s3Concurrency : 3,
        overwriteExisting: s3OverwriteExisting,
        multipartThresholdMB: typeof s3MultipartThresholdMB === 'number' ? s3MultipartThresholdMB : 64,
        multipartPartSizeMB: typeof s3MultipartPartSizeMB === 'number' ? s3MultipartPartSizeMB : 64,
        multipartQueueSize: typeof s3MultipartQueueSize === 'number' ? s3MultipartQueueSize : 4,
      })
      setS3Status(result as LocalToS3StatusResult)
      setS3MigrationMessage('Migration started.')
    } catch (error: any) {
      setS3MigrationMessage(error?.message || 'Failed to start migration')
    } finally {
      setS3MigrationLoading(false)
    }
  }

  async function runS3Cancel() {
    setS3MigrationLoading(true)
    setS3MigrationMessage(null)
    try {
      await apiPost('/api/settings/migrate-local-to-s3/cancel', {})
      setS3MigrationMessage('Cancellation requested.')
    } catch (error: any) {
      setS3MigrationMessage(error?.message || 'Failed to cancel migration')
    } finally {
      setS3MigrationLoading(false)
    }
  }

  async function runAccountingPathRepair(dryRun: boolean) {
    setAccountingPathRepairLoading(true)
    setAccountingPathRepairError(null)
    try {
      const result = await apiPost('/api/settings/normalize-accounting-attachment-paths', { dryRun })
      setAccountingPathRepairResult(result as NormalizeAccountingAttachmentPathsResult)
    } catch (error: any) {
      setAccountingPathRepairError(error?.message || 'Failed to normalize accounting attachment paths')
    } finally {
      setAccountingPathRepairLoading(false)
    }
  }

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
    const scanFailed = orphanProjectFilesResult.missingFiles < 0
    const scannedLabel = `${orphanProjectFilesResult.scannedFiles} files scanned across ${orphanProjectFilesResult.scannedProjects ?? orphanProjectFilesResult.scannedDirectories ?? orphanProjectFilesResult.scannedProjectDirectories} project${(orphanProjectFilesResult.scannedProjects ?? 1) === 1 ? '' : 's'}`
    const orphanLabel = scanFailed
      ? 'Orphan scan skipped — storage listing failed'
      : `${orphanProjectFilesResult.orphanFiles} orphan file${orphanProjectFilesResult.orphanFiles === 1 ? '' : 's'} on storage (${formatBytes(orphanProjectFilesResult.orphanFileBytes)})`
    const missingLabel = scanFailed
      ? 'Missing-file check skipped — storage listing failed'
      : `${orphanProjectFilesResult.missingFiles} missing file${orphanProjectFilesResult.missingFiles === 1 ? '' : 's'} in DB`
    return { scannedLabel, orphanLabel, missingLabel, scanFailed }
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

  function formatAccountingPathRepairSample(entry: NormalizeAccountingAttachmentPathsResult['sample'][number]) {
    if (entry.error) {
      return `[INVALID] ${entry.id} | ${entry.from} | error=${entry.error} | name=${entry.originalName}`
    }
    return `[NORMALIZE] ${entry.id} | ${entry.from} -> ${entry.to} | name=${entry.originalName}`
  }

  return (
    <>
      <Card className="border-border">
      <CardHeader className={hideCollapse ? undefined : "cursor-pointer hover:bg-accent/50 transition-colors"} onClick={hideCollapse ? undefined : () => setShow(!show)}>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Developer Tools</CardTitle>
            <CardDescription>
              Maintenance and diagnostic actions (safe, allow-listed)
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
        <CardContent className="space-y-4 border-t pt-4">
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="space-y-0.5">
              <Label>Local to S3 migration</Label>
              <p className="text-xs text-muted-foreground">
                Copies database-referenced local storage files to S3-compatible storage.
                This does not switch runtime provider. After completion, set STORAGE_PROVIDER=s3 in .env and restart app + worker.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="s3Endpoint">S3 endpoint</Label>
                <Input id="s3Endpoint" value={s3Endpoint} onChange={(event) => setS3Endpoint(event.target.value)} placeholder="https://<account-id>.r2.cloudflarestorage.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3Bucket">Bucket</Label>
                <Input id="s3Bucket" value={s3Bucket} onChange={(event) => setS3Bucket(event.target.value)} placeholder="vitransfer-prod" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3Region">Region</Label>
                <Input id="s3Region" value={s3Region} onChange={(event) => setS3Region(event.target.value)} placeholder="auto" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3AccessKeyId">Access key ID</Label>
                <Input id="s3AccessKeyId" value={s3AccessKeyId} onChange={(event) => setS3AccessKeyId(event.target.value)} placeholder="AKIA..." />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="s3SecretAccessKey">Secret access key</Label>
                <Input id="s3SecretAccessKey" type="password" value={s3SecretAccessKey} onChange={(event) => setS3SecretAccessKey(event.target.value)} placeholder="Secret access key" />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="s3Concurrency">Concurrency</Label>
                <Input
                  id="s3Concurrency"
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  value={s3Concurrency}
                  onChange={(event) => {
                    const next = event.target.value
                    setS3Concurrency(next === '' ? '' : Number(next))
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="s3MultipartThresholdMB">Multipart threshold (MB)</Label>
                <Input
                  id="s3MultipartThresholdMB"
                  type="number"
                  min={5}
                  max={10240}
                  step={1}
                  value={s3MultipartThresholdMB}
                  onChange={(event) => {
                    const next = event.target.value
                    setS3MultipartThresholdMB(next === '' ? '' : Number(next))
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="s3MultipartPartSizeMB">Multipart part size (MB)</Label>
                <Input
                  id="s3MultipartPartSizeMB"
                  type="number"
                  min={5}
                  max={512}
                  step={1}
                  value={s3MultipartPartSizeMB}
                  onChange={(event) => {
                    const next = event.target.value
                    setS3MultipartPartSizeMB(next === '' ? '' : Number(next))
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="s3MultipartQueueSize">Multipart queue size</Label>
                <Input
                  id="s3MultipartQueueSize"
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  value={s3MultipartQueueSize}
                  onChange={(event) => {
                    const next = event.target.value
                    setS3MultipartQueueSize(next === '' ? '' : Number(next))
                  }}
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2 md:col-span-3">
                <div>
                  <div className="text-xs font-medium">Force path style</div>
                  <div className="text-[11px] text-muted-foreground">Recommended for Cloudflare R2.</div>
                </div>
                <Switch checked={s3ForcePathStyle} onCheckedChange={setS3ForcePathStyle} />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2 md:col-span-3">
                <div>
                  <div className="text-xs font-medium">Overwrite existing objects</div>
                  <div className="text-[11px] text-muted-foreground">When off, matching object sizes are skipped.</div>
                </div>
                <Switch checked={s3OverwriteExisting} onCheckedChange={setS3OverwriteExisting} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={s3ValidateLoading || s3MigrationLoading} onClick={() => void runS3Validate()}>
                {s3ValidateLoading ? 'Validating...' : 'Validate credentials'}
              </Button>
              <Button type="button" variant="outline" disabled={s3DryRunLoading || s3MigrationLoading} onClick={() => void runS3DryRun()}>
                {s3DryRunLoading ? 'Running...' : 'Dry run'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={s3MigrationLoading || s3Status?.active}
                onClick={() => setPendingS3Start(true)}
              >
                {s3MigrationLoading ? 'Starting...' : 'Start migration'}
              </Button>
              <Button type="button" variant="outline" disabled={s3MigrationLoading || !s3Status?.active} onClick={() => void runS3Cancel()}>
                {s3MigrationLoading ? 'Cancelling...' : 'Cancel'}
              </Button>
            </div>

            {s3ValidateMessage ? (
              <p className={`text-xs ${s3ValidateMessage.includes('valid') ? 'text-muted-foreground' : 'text-destructive'}`}>
                {s3ValidateMessage}
              </p>
            ) : null}

            {s3MigrationMessage ? (
              <p className={`text-xs ${s3MigrationMessage.toLowerCase().includes('failed') ? 'text-destructive' : 'text-muted-foreground'}`}>
                {s3MigrationMessage}
              </p>
            ) : null}

            {s3DryRunResult ? (
              <div className="space-y-1 rounded-md border border-border bg-background/50 p-3">
                <div className="text-xs text-muted-foreground">Dry run summary</div>
                <div className="text-xs text-muted-foreground">Referenced paths: {s3DryRunResult.discoveredPaths}</div>
                <div className="text-xs text-muted-foreground">Existing local files: {s3DryRunResult.existingLocalFiles}</div>
                {s3DryRunResult.alreadyInS3 != null ? (
                  <div className="text-xs text-muted-foreground">Already in S3 (would skip): {s3DryRunResult.alreadyInS3}</div>
                ) : null}
                <div className="text-xs text-muted-foreground">Missing local files: {s3DryRunResult.missingLocalFiles}</div>
                <div className="text-xs text-muted-foreground">
                  {s3DryRunResult.wouldCopy != null
                    ? <>Files to copy: {s3DryRunResult.wouldCopy}</>
                    : <>Total local files: {s3DryRunResult.existingLocalFiles}</>}
                </div>
                <div className="text-xs text-muted-foreground">Total bytes to copy: {formatBytes(s3DryRunResult.wouldCopyBytes ?? s3DryRunResult.totalBytes)}</div>
                {s3DryRunResult.sampleKeys?.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      {s3DryRunResult.wouldCopy != null
                        ? <>Show new files to copy (first {s3DryRunResult.sampleKeys.length})</>
                        : <>Show sample files to copy (first {s3DryRunResult.sampleKeys.length})</>}
                    </summary>
                    <pre className="mt-2 text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                      {s3DryRunResult.sampleKeys.join('\n')}
                    </pre>
                  </details>
                ) : null}
                {s3DryRunResult.missingKeys?.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-destructive hover:text-destructive/80">
                      Show missing local files ({s3DryRunResult.missingKeys.length}) — DB-referenced paths not found on disk
                    </summary>
                    <pre className="mt-2 text-[11px] whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                      {s3DryRunResult.missingKeys.join('\n')}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {s3Status?.run ? (
              <div className="space-y-2 rounded-md border border-border bg-background/50 p-3">
                <div className="text-xs font-medium">Migration status: {s3Status.run.status}</div>
                <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, s3Status.run.progressPercent))}%` }} />
                </div>
                <div className="grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                  <div>Progress: {s3Status.run.progressPercent}%</div>
                  <div>Current key: {s3Status.run.currentKey || '-'}</div>
                  <div>Files: {s3Status.run.filesProcessed}/{s3Status.run.filesTotal}</div>
                  <div>Copied: {s3Status.run.filesCopied}, skipped: {s3Status.run.filesSkipped}, failed: {s3Status.run.filesFailed}</div>
                  <div>Bytes copied: {formatBytes(s3Status.run.bytesCopied)} / {formatBytes(s3Status.run.bytesTotal)}</div>
                  <div>Speed: {formatBytes(s3Status.run.speedBytesPerSecond)}/s</div>
                  <div>ETA: {formatDuration(s3Status.run.etaSeconds)}</div>
                  <div>Started: {new Date(s3Status.run.startedAt).toLocaleString()}</div>
                  <div>Multipart threshold: {s3Status.run.multipartThresholdMB} MB</div>
                  <div>Multipart part size: {s3Status.run.multipartPartSizeMB} MB</div>
                  <div>Multipart queue: {s3Status.run.multipartQueueSize}</div>
                </div>
                {s3Status.run.errors?.length ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      Show errors ({s3Status.run.errors.length})
                    </summary>
                    <pre className="mt-2 text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                      {s3Status.run.errors.map((error) => `${error.key}: ${error.error}`).join('\n')}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>


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
                <Label>Storage integrity scan</Label>
                <p className="text-xs text-muted-foreground">
                  Checks storage for two classes of issue: <strong>orphan files</strong> — files present on
                  storage that have no matching database record (videos, previews, album photos, comment
                  uploads, Share page UPLOADS files/folder markers, project files, accounting receipts, and
                  more); and <strong>missing files</strong>
                  — database records whose file is absent from storage. Run a dry run first to preview
                  findings. The clean-up action removes orphan files only; missing files must be
                  investigated and re-uploaded manually.
                </p>

                {orphanProjectFilesError ? (
                  <p className="text-xs text-destructive">{orphanProjectFilesError}</p>
                ) : null}

                {orphanProjectFilesSummary ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{orphanProjectFilesSummary.scannedLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {orphanProjectFilesSummary.orphanLabel}
                      {!orphanProjectFilesSummary.scanFailed && orphanProjectFilesResult?.orphanFiles === 0 ? ' — none found ✓' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {orphanProjectFilesSummary.missingLabel}
                      {!orphanProjectFilesSummary.scanFailed && orphanProjectFilesResult?.missingFiles === 0 ? ' — none found ✓' : ''}
                    </p>
                    {orphanProjectFilesResult?.deleted ? (
                      <p className="text-xs text-muted-foreground">
                        Deleted: {orphanProjectFilesResult.deleted.filesDeleted} orphan files
                        {orphanProjectFilesResult.deleted.filesFailed ? ` (${orphanProjectFilesResult.deleted.filesFailed} deletes failed)` : ''}
                        {orphanProjectFilesResult.deleted.emptyDirsPruned ? `; pruned ${orphanProjectFilesResult.deleted.emptyDirsPruned} empty directories` : ''}
                      </p>
                    ) : null}
                    {orphanProjectFilesResult?.errors?.length ? (
                      <p className="text-xs text-muted-foreground">Errors: {orphanProjectFilesResult.errors.length}</p>
                    ) : null}

                    {(orphanProjectFilesResult?.sample || orphanProjectFilesResult?.missingFileSample) ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show sample paths
                        </summary>
                        <div className="mt-2 space-y-2">
                          {orphanProjectFilesResult?.sample ? (
                            <>
                              <div>
                                <div className="text-[11px] font-medium text-muted-foreground">Orphan paths (first 20)</div>
                                <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                  {orphanProjectFilesResult.sample.orphanPaths.join('\n') || 'None'}
                                </pre>
                              </div>
                              <div>
                                <div className="text-[11px] font-medium text-muted-foreground">Related project IDs</div>
                                <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                  {orphanProjectFilesResult.sample.projectIds.join('\n') || 'None'}
                                </pre>
                              </div>
                            </>
                          ) : null}

                          {orphanProjectFilesResult?.missingFileSample?.paths.length ? (
                            <div>
                              <div className="text-[11px] font-medium text-muted-foreground">Missing file paths (first 20)</div>
                              <pre className="text-[11px] whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 p-2">
                                {orphanProjectFilesResult.missingFileSample.paths.join('\n')}
                              </pre>
                            </div>
                          ) : null}

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
                  onClick={() => setPendingOrphanCleanup(true)}
                >
                  {orphanProjectFilesLoading ? 'Running…' : 'Clean up orphans'}
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
                  onClick={() => setPendingBacklogPurge(true)}
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
                  onClick={() => setPendingBullmqPurge(true)}
                >
                  {bullmqPurgeLoading ? 'Running\u2026' : 'Purge jobs'}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      )}
      </Card>

      <ConfirmDialog
        open={pendingS3Start}
        onOpenChange={(v) => { if (!v) setPendingS3Start(false) }}
        title="Start S3 Migration?"
        description="Start local to S3 migration now? Keep STORAGE_PROVIDER=local until copy completes."
        confirmLabel="Start Migration"
        variant="default"
        onConfirm={() => { setPendingS3Start(false); void runS3Start() }}
      />
      <ConfirmDialog
        open={pendingOrphanCleanup}
        onOpenChange={(v) => { if (!v) setPendingOrphanCleanup(false) }}
        title="Clean Up Orphan Files?"
        description="Delete orphan files from storage? Missing files (DB records with no file) will NOT be deleted and must be re-uploaded manually. This cannot be undone."
        confirmLabel="Clean Up"
        onConfirm={() => { setPendingOrphanCleanup(false); void runOrphanProjectFilesCleanup(false) }}
      />
      <ConfirmDialog
        open={pendingBacklogPurge}
        onOpenChange={(v) => { if (!v) setPendingBacklogPurge(false) }}
        title="Dismiss Notification Backlog?"
        description="Mark all unsent notification queue entries older than 7 days as already sent? They will not be delivered."
        confirmLabel="Dismiss Backlog"
        onConfirm={() => { setPendingBacklogPurge(false); void runBacklogPurge(false) }}
      />
      <ConfirmDialog
        open={pendingBullmqPurge}
        onOpenChange={(v) => { if (!v) setPendingBullmqPurge(false) }}
        title="Purge Stale BullMQ Jobs?"
        description="Purge all stale completed and failed BullMQ jobs from Redis? Active and waiting jobs are not affected."
        confirmLabel="Purge Jobs"
        onConfirm={() => { setPendingBullmqPurge(false); void runBullmqPurge(false) }}
      />
    </>
  )
}
