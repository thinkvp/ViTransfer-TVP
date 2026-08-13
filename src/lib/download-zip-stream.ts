import { downloadZip } from 'client-zip'

export type ZipEntry = {
  url: string
  fileName: string
  fileSizeBytes?: number
}

/** Where the finished ZIP should be written. Produced by `pickZipSaveTarget`. */
export type ZipSaveTarget =
  | { kind: 'file-system'; handle: FileSystemFileHandle }
  | { kind: 'memory' }
  | { kind: 'canceled' }

export interface DownloadFilesAsZipOptions {
  /** Called with (loadedBytes, totalBytes) as data is written into the ZIP. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void
  /** Cancels in-flight fetches and the write to disk. */
  signal?: AbortSignal
  /** Destination for the archive. Defaults to the in-memory Blob fallback. */
  saveTarget?: ZipSaveTarget
}

/**
 * How many member files may be fetched *ahead* of the one currently being
 * written into the ZIP.
 *
 * client-zip consumes entries strictly in order, so any response opened early
 * just sits there back-pressured while holding a connection slot and filling
 * the browser's receive buffers. Opening every entry up front deadlocks a large
 * selection: over HTTP/1.1 the first six requests occupy the whole per-host
 * connection pool with bodies nobody is reading yet (so they never finish and
 * never free a slot, and the remaining requests are never dispatched), and over
 * HTTP/2 the stalled streams exhaust the session flow-control window until even
 * the stream being written can no longer receive data. One file in flight ahead
 * of the writer hides per-file latency without either failure mode.
 */
const ZIP_PREFETCH_COUNT = 1

/**
 * Wraps a Response body in a TransformStream that calls `onBytes` for every
 * chunk passing through, enabling aggregate progress tracking across entries.
 */
function wrapResponseWithProgress(
  response: Response,
  onBytes: (n: number) => void
): Response {
  if (!response.body) return response

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength)
      controller.enqueue(chunk)
    },
  })

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    headers: response.headers,
  })
}

/**
 * Opens the browser's "save file" dialog for a ZIP download.
 *
 * MUST be called synchronously from a user gesture (i.e. before the first
 * `await` in the click handler's call chain) — `showSaveFilePicker` requires
 * transient user activation, which expires a few seconds after the click and
 * long before a batch of download tokens and file requests has resolved.
 *
 * Returns `canceled` when the user dismissed the dialog, and `memory` when the
 * File System Access API is unavailable (Firefox / Safari) or refused, in which
 * case the caller falls back to buffering the archive in memory.
 */
export async function pickZipSaveTarget(zipFileName: string): Promise<ZipSaveTarget> {
  if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) {
    return { kind: 'memory' }
  }

  try {
    const handle: FileSystemFileHandle = await (window as any).showSaveFilePicker({
      suggestedName: zipFileName,
      types: [
        {
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] },
        },
      ],
    })
    return { kind: 'file-system', handle }
  } catch (err: any) {
    // User dismissed the save-file picker — treat as cancellation.
    if (err?.name === 'AbortError') return { kind: 'canceled' }
    // Any other FSAPI error (no transient activation, insecure context, …):
    // fall back to the Blob download rather than failing the transfer.
    console.warn('Save-file picker unavailable, falling back to Blob download:', err)
    return { kind: 'memory' }
  }
}

/**
 * Lazily yields client-zip inputs, fetching each entry only when the archive
 * writer is ready for it (plus `ZIP_PREFETCH_COUNT` files of lookahead).
 */
async function* streamZipInputs(
  entries: ZipEntry[],
  onBytes: ((n: number) => void) | undefined,
  signal: AbortSignal | undefined
) {
  const startFetch = (entry: ZipEntry): Promise<Response> => {
    const request = fetch(entry.url, signal ? { signal } : undefined).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch "${entry.fileName}": HTTP ${response.status}`)
      }
      return response
    })
    // A prefetched entry is awaited only once the writer reaches it, so mark
    // rejections as handled now to avoid an unhandled-rejection warning; the
    // error still surfaces from the `await` below.
    request.catch(() => {})
    return request
  }

  const pending: Array<{ entry: ZipEntry; response: Promise<Response> }> = []
  let nextIndex = 0

  const fillWindow = () => {
    while (pending.length < ZIP_PREFETCH_COUNT && nextIndex < entries.length) {
      const entry = entries[nextIndex++]
      pending.push({ entry, response: startFetch(entry) })
    }
  }

  try {
    fillWindow()

    while (pending.length) {
      const { entry, response } = pending.shift()!
      const resolved = await response
      // Start the next fetch only once this one is handed to the writer, so at
      // most ZIP_PREFETCH_COUNT + 1 responses are open at any time.
      fillWindow()

      yield {
        name: entry.fileName,
        input: onBytes ? wrapResponseWithProgress(resolved, onBytes) : resolved,
        // Providing size lets client-zip write correct local-file headers upfront.
        ...(entry.fileSizeBytes != null ? { size: entry.fileSizeBytes } : {}),
      }
    }
  } finally {
    // Abandoned early (error or cancellation): release prefetched bodies so
    // their connections don't linger.
    for (const item of pending) {
      void item.response.then((response) => response.body?.cancel()).catch(() => {})
    }
  }
}

/**
 * Downloads multiple files as a single streaming ZIP.
 *
 * - Files are fetched one at a time (with a small lookahead) in the order
 *   client-zip writes them — no data passes through the Next.js server beyond
 *   the per-file content routes themselves.
 * - Writes straight to disk via the File System Access API when the caller
 *   supplied a `file-system` save target: no service worker needed and no
 *   memory limits regardless of ZIP size.
 * - Falls back to collecting as a Blob for Firefox/Safari (memory-bound, but
 *   acceptable for typical selections).
 * - Progress is reported as bytes written into the ZIP vs total known bytes.
 *   When `fileSizeBytes` is omitted for some entries the percentage will be
 *   approximate; `onProgress` is still called so the UI shows activity.
 *
 * @param entries     Files to include in the ZIP.
 * @param zipFileName Filename used by the Blob fallback.
 * @param options     Progress callback, abort signal and save target.
 */
export async function downloadFilesAsZip(
  entries: ZipEntry[],
  zipFileName: string,
  options: DownloadFilesAsZipOptions = {}
): Promise<void> {
  const { onProgress, signal, saveTarget = { kind: 'memory' } } = options

  if (!entries.length) return
  if (saveTarget.kind === 'canceled') return

  const totalBytes = entries.reduce(
    (sum, e) => (e.fileSizeBytes != null ? sum + e.fileSizeBytes : sum),
    0
  )
  let loadedBytes = 0

  const onBytes = onProgress
    ? (n: number) => {
        loadedBytes += n
        onProgress(loadedBytes, totalBytes)
      }
    : undefined

  const zipResponse = downloadZip(streamZipInputs(entries, onBytes, signal))
  const zipBody = zipResponse.body

  if (!zipBody) {
    throw new Error('client-zip returned a response with no body')
  }

  // ── File System Access API (Chrome / Edge 86+) ────────────────────────────
  // No service worker required; handles arbitrarily large ZIPs without
  // buffering into memory.
  if (saveTarget.kind === 'file-system') {
    const writable = await saveTarget.handle.createWritable()
    await zipBody.pipeTo(writable, signal ? { signal } : undefined)
    return
  }

  // ── Blob fallback (Firefox / Safari) ─────────────────────────────────────
  // Collects the entire ZIP into memory before triggering the download.
  // Works reliably for typical file selections; may fail for very large ZIPs
  // on memory-constrained devices.
  const blobResponse = new Response(zipBody)
  const blob = await blobResponse.blob()
  const objectUrl = URL.createObjectURL(blob)

  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = zipFileName
    anchor.style.display = 'none'
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    // Revoke after a short delay to allow the browser to start the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  }
}
