'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { DownloadableFile } from '@/lib/downloadable-files'
import type { DownloadQueueItem } from '@/lib/download-queue'
import { downloadFilesAsZip } from '@/lib/download-zip-stream'
import {
  calculateTransferSummary,
  createTransferId,
  isTransferActive,
  MANAGED_DOWNLOAD_CONCURRENCY,
  type TransferItem,
  type TransferSummary,
  ZIP_DOWNLOAD_THRESHOLD_BYTES,
} from '@/lib/transfer-state'

export type DownloadProgressSnapshot = Pick<TransferSummary, 'percent' | 'speedBytesPerSecond' | 'etaSeconds'>

type ResolveDownloadTarget = (
  file: DownloadableFile,
  signal?: AbortSignal
) => Promise<DownloadQueueItem | null>

interface UseDownloadTransfersOptions {
  projectTitle?: string | null
  resolveDownloadTarget: ResolveDownloadTarget
}

interface TransferBatchController {
  batchId: string
  controller: AbortController
}

const DOWNLOAD_DISPATCH_DELAY_MS = 350
const TRANSFER_METRICS_UPDATE_INTERVAL_MS = 750

function dispatchBrowserDownload(item: DownloadQueueItem) {
  const anchor = document.createElement('a')
  anchor.href = item.url
  if (item.fileName) {
    anchor.download = item.fileName
  }
  anchor.style.display = 'none'
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function toProgressSnapshot(summary: TransferSummary | null): DownloadProgressSnapshot {
  return {
    percent: summary?.percent ?? 0,
    speedBytesPerSecond: summary?.speedBytesPerSecond ?? null,
    etaSeconds: summary?.etaSeconds ?? null,
  }
}

export function useDownloadTransfers({ projectTitle, resolveDownloadTarget }: UseDownloadTransfersOptions) {
  const [transferItems, setTransferItems] = useState<TransferItem[]>([])
  const [transferPanelVersion, setTransferPanelVersion] = useState(0)
  const batchControllerRef = useRef<TransferBatchController | null>(null)
  const transferItemsRef = useRef<TransferItem[]>([])

  const setTransferItemsState = useCallback((items: TransferItem[]) => {
    transferItemsRef.current = items
    setTransferItems(items)
  }, [])

  const transferSummary = useMemo(() => calculateTransferSummary(transferItems), [transferItems])
  const hasActiveTransfers = useMemo(
    () => transferItems.some((item) => isTransferActive(item.status)),
    [transferItems]
  )

  const cancelActiveTransfers = useCallback(() => {
    batchControllerRef.current?.controller.abort()
  }, [])

  const clearCompletedTransfers = useCallback(() => {
    setTransferItemsState(
      transferItemsRef.current.filter((item) => isTransferActive(item.status))
    )
  }, [setTransferItemsState])

  const startBatch = useCallback((items: TransferItem[]) => {
    batchControllerRef.current?.controller.abort()

    const batchId = createTransferId('batch')
    const controller = new AbortController()
    batchControllerRef.current = { batchId, controller }
    setTransferItemsState(items)
    setTransferPanelVersion((value) => value + 1)
    return { batchId, controller }
  }, [setTransferItemsState])

  const finishBatch = useCallback((batchId: string) => {
    if (batchControllerRef.current?.batchId === batchId) {
      batchControllerRef.current = null
    }
  }, [])

  const updateTransferItems = useCallback((updater: (items: TransferItem[]) => TransferItem[]) => {
    const nextItems = updater(transferItemsRef.current)
    setTransferItemsState(nextItems)
    return nextItems
  }, [setTransferItemsState])

  const runQueuedDownloads = useCallback(async (
    files: DownloadableFile[],
    onProgress?: (progress: DownloadProgressSnapshot) => void
  ) => {
    const initialItems: TransferItem[] = files.map((file) => ({
      id: createTransferId('download'),
      direction: 'download',
      kind: 'file',
      fileName: file.fileName,
      progressPercent: 0,
      status: 'queued',
      fileSizeBytes: file.fileSizeBytes != null ? Number(file.fileSizeBytes) : null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      errorMessage: null,
    }))

    const { batchId, controller } = startBatch(initialItems)
    const { signal } = controller

    const notifyProgress = (items: TransferItem[]) => {
      onProgress?.(toProgressSnapshot(calculateTransferSummary(items)))
    }

    notifyProgress(initialItems)

    let nextIndex = 0

    const worker = async () => {
      while (!signal.aborted) {
        const currentIndex = nextIndex
        nextIndex += 1

        if (currentIndex >= files.length) {
          return
        }

        const currentFile = files[currentIndex]
        const currentTransferId = initialItems[currentIndex].id

        let itemsAfterUpdate = updateTransferItems((items) =>
          items.map((item) =>
            item.id === currentTransferId
              ? {
                  ...item,
                  status: 'preparing',
                  progressPercent: 10,
                  errorMessage: null,
                }
              : item
          )
        )
        notifyProgress(itemsAfterUpdate)

        try {
          const target = await resolveDownloadTarget(currentFile, signal)

          if (signal.aborted) {
            itemsAfterUpdate = updateTransferItems((items) =>
              items.map((item) =>
                item.id === currentTransferId
                  ? {
                      ...item,
                      status: 'canceled',
                      speedBytesPerSecond: null,
                      etaSeconds: null,
                    }
                  : item
              )
            )
            notifyProgress(itemsAfterUpdate)
            return
          }

          if (!target) {
            throw new Error('Unable to prepare this download.')
          }

          dispatchBrowserDownload(target)

          itemsAfterUpdate = updateTransferItems((items) =>
            items.map((item) =>
              item.id === currentTransferId
                ? {
                    ...item,
                    status: 'browser',
                    progressPercent: 100,
                    speedBytesPerSecond: null,
                    etaSeconds: null,
                    errorMessage: 'Browser-managed download. Live progress is not available.',
                  }
                : item
            )
          )
          notifyProgress(itemsAfterUpdate)

          await delay(DOWNLOAD_DISPATCH_DELAY_MS)
        } catch (error) {
          const wasCanceled = signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
          itemsAfterUpdate = updateTransferItems((items) =>
            items.map((item) =>
              item.id === currentTransferId
                ? {
                    ...item,
                    status: wasCanceled ? 'canceled' : 'failed',
                    speedBytesPerSecond: null,
                    etaSeconds: null,
                    errorMessage: wasCanceled
                      ? 'Canceled'
                      : error instanceof Error
                        ? error.message
                        : 'Download failed'
                  }
                : item
            )
          )
          notifyProgress(itemsAfterUpdate)
        }
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(MANAGED_DOWNLOAD_CONCURRENCY, files.length) }, () => worker())
      )
    } finally {
      finishBatch(batchId)
    }
  }, [finishBatch, resolveDownloadTarget, startBatch, updateTransferItems])

  const runZipDownload = useCallback(async (
    files: DownloadableFile[],
    onProgress?: (progress: DownloadProgressSnapshot) => void
  ) => {
    const zipFileName = `${projectTitle || 'Download'} Files.zip`
    const zipTransferId = createTransferId('zip')

    const initialItem: TransferItem = {
      id: zipTransferId,
      direction: 'download',
      kind: 'zip',
      fileName: zipFileName,
      progressPercent: 0,
      status: 'preparing',
      fileSizeBytes: files.reduce((sum, file) => sum + (file.fileSizeBytes != null ? Number(file.fileSizeBytes) : 0), 0),
      speedBytesPerSecond: null,
      etaSeconds: null,
      errorMessage: null,
    }

    const { batchId, controller } = startBatch([initialItem])
    const { signal } = controller
    const progressRef = {
      lastLoaded: 0,
      lastTime: Date.now(),
      smoothedSpeed: null as number | null,
      lastMetricsUpdateTime: 0,
    }

    const notifyProgress = (items: TransferItem[]) => {
      onProgress?.(toProgressSnapshot(calculateTransferSummary(items)))
    }

    notifyProgress([initialItem])

    try {
      const targets = await Promise.all(files.map((file) => resolveDownloadTarget(file, signal)))

      if (signal.aborted) {
        const canceledItems = updateTransferItems((items) =>
          items.map((item) => ({
            ...item,
            status: 'canceled',
            speedBytesPerSecond: null,
            etaSeconds: null,
            errorMessage: 'Canceled',
          }))
        )
        notifyProgress(canceledItems)
        return
      }

      const validTargets = targets.filter((item): item is DownloadQueueItem => Boolean(item))
      if (!validTargets.length) {
        throw new Error('Unable to prepare this download.')
      }

      const entries = validTargets.map((target, index) => ({
        url: target.url,
        fileName: target.fileName || files[index]?.fileName || 'file',
        fileSizeBytes: files[index]?.fileSizeBytes != null ? Number(files[index].fileSizeBytes) : undefined,
      }))

      let nextItems = updateTransferItems((items) =>
        items.map((item) =>
          item.id === zipTransferId
            ? {
                ...item,
                status: 'transferring',
                progressPercent: 0,
              }
            : item
        )
      )
      notifyProgress(nextItems)

      await downloadFilesAsZip(
        entries,
        zipFileName,
        (loaded, total) => {
          const now = Date.now()
          const previous = progressRef
          let speedBytesPerSecond: number | null = previous.smoothedSpeed

          if (now > previous.lastTime && loaded >= previous.lastLoaded) {
            const deltaBytes = loaded - previous.lastLoaded
            const deltaSeconds = (now - previous.lastTime) / 1000
            if (deltaBytes > 0 && deltaSeconds > 0) {
              const instantSpeed = deltaBytes / deltaSeconds
              speedBytesPerSecond = previous.smoothedSpeed == null
                ? instantSpeed
                : (previous.smoothedSpeed * 0.7) + (instantSpeed * 0.3)
            }
          }

          const etaSeconds = total > 0 && speedBytesPerSecond && speedBytesPerSecond > 0
            ? Math.max(0, (total - loaded) / speedBytesPerSecond)
            : null

          progressRef.lastLoaded = loaded
          progressRef.lastTime = now
          progressRef.smoothedSpeed = speedBytesPerSecond

          const shouldPublishMetrics = now - progressRef.lastMetricsUpdateTime >= TRANSFER_METRICS_UPDATE_INTERVAL_MS
            || (total > 0 && loaded >= total)

          if (shouldPublishMetrics) {
            progressRef.lastMetricsUpdateTime = now
          }

          nextItems = updateTransferItems((items) =>
            items.map((item) =>
              item.id === zipTransferId
                ? {
                    ...item,
                    status: 'transferring',
                    progressPercent: total > 0 ? Math.round((loaded / total) * 100) : item.progressPercent,
                    speedBytesPerSecond: shouldPublishMetrics ? speedBytesPerSecond : item.speedBytesPerSecond,
                    etaSeconds: shouldPublishMetrics ? etaSeconds : item.etaSeconds,
                    errorMessage: null,
                  }
                : item
            )
          )
          if (shouldPublishMetrics || (total > 0 && loaded >= total)) {
            notifyProgress(nextItems)
          }
        },
        signal
      )

      nextItems = updateTransferItems((items) =>
        items.map((item) =>
          item.id === zipTransferId
            ? {
                ...item,
                status: 'completed',
                progressPercent: 100,
                speedBytesPerSecond: null,
                etaSeconds: null,
                errorMessage: null,
              }
            : item
        )
      )
      notifyProgress(nextItems)
    } catch (error) {
      const wasCanceled = signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const nextItems = updateTransferItems((items) =>
        items.map((item) =>
          item.id === zipTransferId
            ? {
                ...item,
                status: wasCanceled ? 'canceled' : 'failed',
                speedBytesPerSecond: null,
                etaSeconds: null,
                errorMessage: wasCanceled
                  ? 'Canceled'
                  : error instanceof Error
                    ? error.message
                    : 'Download failed',
              }
            : item
        )
      )
      notifyProgress(nextItems)
    } finally {
      finishBatch(batchId)
    }
  }, [finishBatch, projectTitle, resolveDownloadTarget, startBatch, updateTransferItems])

  const downloadFile = useCallback(async (file: DownloadableFile) => {
    await runQueuedDownloads([file])
  }, [runQueuedDownloads])

  const downloadFiles = useCallback(async (
    files: DownloadableFile[],
    onProgress?: (progress: DownloadProgressSnapshot) => void
  ) => {
    if (!files.length) return
    if (transferItemsRef.current.some((item) => isTransferActive(item.status))) return

    const knownByteSizes = files
      .map((file) => (file.fileSizeBytes != null ? Number(file.fileSizeBytes) : null))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)

    const allSizesKnown = knownByteSizes.length === files.length
    const totalKnownBytes = knownByteSizes.reduce((sum, value) => sum + value, 0)
    const shouldZip = files.length > 1 && allSizesKnown && totalKnownBytes < ZIP_DOWNLOAD_THRESHOLD_BYTES

    if (shouldZip) {
      await runZipDownload(files, onProgress)
      return
    }

    await runQueuedDownloads(files, onProgress)
  }, [runQueuedDownloads, runZipDownload])

  return {
    transferItems,
    transferSummary,
    hasActiveTransfers,
    transferPanelVersion,
    downloadFile,
    downloadFiles,
    cancelActiveTransfers,
    clearCompletedTransfers,
  }
}