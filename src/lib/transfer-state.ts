// Client-side ZIP creation is capped at 1GB across all browsers.
export const ZIP_DOWNLOAD_THRESHOLD_BYTES = 1_000_000_000
// Browser-managed multi-file dispatch is most reliable when serialized.
export const MANAGED_DOWNLOAD_CONCURRENCY = 1
// Number of concurrent file writes during FSA bulk downloads.
export const BULK_DOWNLOAD_CONCURRENCY = 3

export type TransferDirection = 'download' | 'upload'
export type TransferKind = 'file' | 'zip'
export type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'transferring'
  | 'browser'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface TransferItem {
  id: string
  direction: TransferDirection
  kind: TransferKind
  fileName: string
  uploadFolderPath?: string
  progressPercent: number
  status: TransferStatus
  fileSizeBytes?: number | null
  speedBytesPerSecond: number | null
  etaSeconds: number | null
  errorMessage?: string | null
}

export interface TransferSummary {
  percent: number
  speedBytesPerSecond: number | null
  etaSeconds: number | null
  activeCount: number
  totalCount: number
}

const ACTIVE_TRANSFER_STATUSES: TransferStatus[] = ['queued', 'preparing', 'transferring']

export function isTransferActive(status: TransferStatus): boolean {
  return ACTIVE_TRANSFER_STATUSES.includes(status)
}

export function calculateTransferSummary(items: TransferItem[]): TransferSummary | null {
  if (!items.length) return null

  const activeItems = items.filter((item) => isTransferActive(item.status))
  const percent = Math.round(
    items.reduce((sum, item) => sum + Math.max(0, Math.min(100, item.progressPercent)), 0) / items.length
  )

  const knownSpeeds = activeItems
    .map((item) => item.speedBytesPerSecond)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)

  const knownEtas = activeItems
    .map((item) => item.etaSeconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)

  const estimatedRemainingBytes = activeItems
    .map((item) => {
      const rawSize = item.fileSizeBytes
      const sizeBytes = typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize >= 0
        ? rawSize
        : null

      if (sizeBytes != null) {
        const progress = Math.max(0, Math.min(100, item.progressPercent)) / 100
        return Math.max(0, sizeBytes * (1 - progress))
      }

      const speed = item.speedBytesPerSecond
      const eta = item.etaSeconds
      if (
        typeof speed === 'number' && Number.isFinite(speed) && speed > 0
        && typeof eta === 'number' && Number.isFinite(eta) && eta > 0
      ) {
        return speed * eta
      }

      return null
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)

  const totalEstimatedRemainingBytes = estimatedRemainingBytes.reduce((sum, value) => sum + value, 0)
  const totalKnownSpeed = knownSpeeds.reduce((sum, value) => sum + value, 0)
  const aggregateEtaSeconds = totalEstimatedRemainingBytes > 0 && totalKnownSpeed > 0
    ? totalEstimatedRemainingBytes / totalKnownSpeed
    : null

  return {
    percent,
    speedBytesPerSecond: totalKnownSpeed > 0 ? totalKnownSpeed : null,
    etaSeconds: aggregateEtaSeconds ?? (knownEtas.length > 0 ? Math.max(...knownEtas) : null),
    activeCount: activeItems.length,
    totalCount: items.length,
  }
}

export function createTransferId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}