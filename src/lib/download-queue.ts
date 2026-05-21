export type DownloadQueueItem = {
  url: string
  fileName?: string
}

const DOWNLOAD_QUEUE_DELAY_MS = 350

function queueSingleDownload(item: DownloadQueueItem) {
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

export async function queueDownloads(items: DownloadQueueItem[]): Promise<void> {
  const validItems = items.filter((item) => typeof item.url === 'string' && item.url.length > 0)
  if (!validItems.length) return

  for (let i = 0; i < validItems.length; i += 1) {
    queueSingleDownload(validItems[i])

    // Small spacing helps browsers enqueue consecutive downloads reliably.
    if (i < validItems.length - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, DOWNLOAD_QUEUE_DELAY_MS)
      })
    }
  }
}
