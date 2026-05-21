import { downloadZip } from 'client-zip'

export type ZipEntry = {
  url: string
  fileName: string
  fileSizeBytes?: number
}

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
 * Downloads multiple files as a single streaming ZIP directly to disk.
 *
 * - Files are fetched directly from their URLs (R2 presigned URLs or local API
 *   routes) — no data passes through the Next.js server.
 * - Uses the File System Access API (Chrome/Edge) when available: no service
 *   worker needed and no memory limits regardless of ZIP size.
 * - Falls back to collecting as a Blob for Firefox/Safari (memory-bound, but
 *   acceptable for typical selections).
 * - Progress is reported as bytes written into the ZIP vs total known bytes.
 *   When `fileSizeBytes` is omitted for some entries the percentage will be
 *   approximate; `onProgress` is still called so the UI shows activity.
 *
 * @param entries     Files to include in the ZIP.
 * @param zipFileName Suggested filename for the saved archive.
 * @param onProgress  Called with (loadedBytes, totalBytes) as data arrives.
 *                    `totalBytes` is 0 when file sizes are unknown.
 * @param signal      Optional AbortSignal to cancel in-flight fetches.
 */
export async function downloadFilesAsZip(
  entries: ZipEntry[],
  zipFileName: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!entries.length) return

  const totalBytes = entries.reduce(
    (sum, e) => (e.fileSizeBytes != null ? sum + e.fileSizeBytes : sum),
    0
  )
  let loadedBytes = 0

  // Start all fetches in parallel so network latency overlaps, then pass
  // resolved responses to client-zip using its expected input shape.
  const fileInputs = await Promise.all(
    entries.map(async (entry) => {
      const response = await fetch(entry.url, signal ? { signal } : undefined)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch "${entry.fileName}": HTTP ${response.status}`
        )
      }

      const input = onProgress
        ? wrapResponseWithProgress(response, (n) => {
            loadedBytes += n
            onProgress(loadedBytes, totalBytes)
          })
        : response

      return {
        name: entry.fileName,
        input,
        // Providing size lets client-zip write correct local-file headers upfront.
        ...(entry.fileSizeBytes != null ? { size: entry.fileSizeBytes } : {}),
      }
    })
  )

  const zipResponse = downloadZip(fileInputs)
  const zipBody = zipResponse.body

  if (!zipBody) {
    throw new Error('client-zip returned a response with no body')
  }

  // ── File System Access API (Chrome / Edge 86+) ────────────────────────────
  // No service worker required; handles arbitrarily large ZIPs without
  // buffering into memory.
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: zipFileName,
        types: [
          {
            description: 'ZIP archive',
            accept: { 'application/zip': ['.zip'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await zipBody.pipeTo(writable, signal ? { signal } : undefined)
      return
    } catch (err: any) {
      // User dismissed the save-file picker — treat as cancellation.
      if (err?.name === 'AbortError') return
      // Any other FSAPI error: fall through to the Blob fallback.
      console.warn('FSAPI save failed, falling back to Blob download:', err)
    }
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
