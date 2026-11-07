/**
 * Paces bulk-download content requests so a multi-file download can't get the viewer's
 * own IP banned.
 *
 * Every file in a bulk download is fetched from its own one-off URL
 * (`/api/content/<token>`, `/api/content/photo-zip/<token>`, …). The VPS runs CrowdSec's
 * `crowdsecurity/http-crawl-non_statics` scenario, which counts distinct last path segments
 * on extension-less GETs: a leaky bucket of capacity 40 that drains one entry every 0.5s.
 * Small files (image assets, subtitles, client uploads) used to be fetched back-to-back at
 * 5–10 per second, so a selection of ~50 of them overflowed the bucket and banned the IP
 * for 4 hours (SSH included). In S3 mode the content route only redirects to R2, but the
 * request still reaches the VPS, so it still counts.
 *
 * Starting at most one content request per CONTENT_REQUEST_MIN_INTERVAL_MS keeps the
 * arrival rate below the drain rate, so the bucket never builds up no matter how many files
 * are selected. Large files are unaffected (each takes far longer than the interval); the
 * cost is that N tiny files take at least N × 0.6s.
 *
 * The pacer is shared module-wide so every download path on the page (ZIP stream, folder
 * download, queued browser downloads, single clicks) draws from the same budget.
 */
export const CONTENT_REQUEST_MIN_INTERVAL_MS = 600

let nextSlotAt = 0

/** Resolves when the caller may start its next content request; rejects if aborted first. */
export function paceContentRequest(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + CONTENT_REQUEST_MIN_INTERVAL_MS
  const wait = slot - now
  if (wait <= 0) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, wait)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
