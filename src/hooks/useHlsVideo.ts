import { useEffect, useRef, type RefObject } from 'react'
import Hls from 'hls.js'

/** A URL is HLS when it points at an .m3u8 playlist (our master URLs end in master.m3u8). */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url)
}

/**
 * Attach a playback URL to a `<video>` element, transparently handling both HLS (`.m3u8`)
 * and plain progressive files (MP4 etc.). For HLS it uses hls.js (MSE) where supported —
 * every desktop browser, incl. desktop Safari — and falls back to native HLS on iOS Safari;
 * for a plain file it just sets `src`. The element must NOT also bind `src` in JSX — this hook
 * owns the source so it can tear hls.js down cleanly when the URL changes or the element unmounts.
 *
 * Reuses the same tight buffer config as the main player so it fetches segments as it plays
 * rather than prefetching the whole asset. Single-rendition asset bundles have no ABR, but the
 * buffer caps and proxy-robust segment delivery still apply.
 */
export function useHlsVideo(
  videoRef: RefObject<HTMLVideoElement | null>,
  url: string | null | undefined,
  onFatalError?: () => void,
): void {
  // Keep the latest callback in a ref so the attach effect can stay keyed only on `url`
  // (assigning in an effect, not during render).
  const onFatalErrorRef = useRef(onFatalError)
  useEffect(() => { onFatalErrorRef.current = onFatalError }, [onFatalError])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return

    // Plain progressive file — let the element load it directly.
    if (!isHlsUrl(url)) {
      if (video.src !== url) video.src = url
      return
    }

    // HLS via hls.js (MSE) wherever supported.
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 30,
        maxBufferSize: 30 * 1000 * 1000,
        backBufferLength: 60,
        capLevelToPlayerSize: true,
      })
      hls.attachMedia(video)
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url))
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); return } catch { /* fall through */ }
        }
        onFatalErrorRef.current?.()
      })
      return () => {
        try { hls.destroy() } catch { /* ignore */ }
      }
    }

    // Native HLS (iOS Safari): the element plays the .m3u8 directly.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      if (video.src !== url) video.src = url
      return
    }

    // No HLS support at all (very old browser) — nothing to attach.
    onFatalErrorRef.current?.()
  }, [videoRef, url])
}
