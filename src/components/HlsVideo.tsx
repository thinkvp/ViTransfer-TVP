'use client'

import { useRef, type VideoHTMLAttributes } from 'react'
import { useHlsVideo } from '@/hooks/useHlsVideo'

type HlsVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> & {
  /** Playback URL — an HLS `.m3u8` master (handled via hls.js / native) or a plain file. */
  url: string | null | undefined
  /** Called on an unrecoverable HLS error. */
  onFatalError?: () => void
}

/**
 * A `<video>` that transparently plays HLS (`.m3u8`) or progressive files, via `useHlsVideo`.
 * Don't pass `src` — this owns the element source so hls.js can be torn down cleanly. Give it a
 * `key` that changes with `url` if you want a full remount (e.g. for autoPlay on source change).
 */
export function HlsVideo({ url, onFatalError, ...rest }: HlsVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  useHlsVideo(ref, url, onFatalError)
  return <video ref={ref} {...rest} />
}
