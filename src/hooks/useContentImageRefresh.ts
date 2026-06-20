'use client'

import { useEffect, useRef, useCallback } from 'react'

const CONTENT_API_PATH = '/api/content/'
const DEBOUNCE_MS = 2_000
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes floor
const MIN_AWAY_MS = 30_000 // Only refresh on visibility if tab was hidden >30s
const HEARTBEAT_INTERVAL_MS = 20_000 // Wall-clock heartbeat tick
const SLEEP_GAP_MS = 60_000 // A gap this large between ticks means the device slept / timers were throttled

function isContentApiUrl(url: string): boolean {
  return url.includes(CONTENT_API_PATH)
}

interface UseContentImageRefreshOptions {
  /** Called (debounced) when content image errors are detected or proactive refresh fires. */
  onRefresh: () => void
  /** Whether the page is currently authenticated/active. */
  enabled?: boolean
  /** Proactive refresh interval in ms. Defaults to 10 minutes. */
  refreshIntervalMs?: number
}

/**
 * Multi-layer defence against stale content API tokens causing broken thumbnails
 * after a user returns from being AFK.
 *
 * Layer 1 – Global error capture: listens (capture phase) for <img> error events
 *   whose src points to /api/content/...  Debounces multiple rapid errors into a
 *   single onRefresh call.
 *
 * Layer 2 – Proactive periodic refresh: calls onRefresh on a configurable interval
 *   so tokens are re-issued before they expire in Redis.
 *
 * Layer 3 – Visibility-change refresh: when the tab becomes visible after being
 *   hidden for >30 s (user returns from AFK), calls onRefresh.
 *
 * Layer 4 – Sleep/throttle detection: a short wall-clock heartbeat detects when
 *   the device slept or timers were suspended (gap between ticks >> interval) and
 *   refreshes on wake. This covers the "AFK at the desk, display/PC sleeps while
 *   the tab stays visible" case, which fires neither a visibilitychange nor a
 *   window focus event, and which suspends the Layer 2 interval mid-cycle so its
 *   next run lands after the Redis token TTL has already lapsed.
 */
export function useContentImageRefresh({
  onRefresh,
  enabled = true,
  refreshIntervalMs = 10 * 60 * 1000,
}: UseContentImageRefreshOptions) {
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHiddenAtRef = useRef<number>(0)

  const triggerRefresh = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      onRefreshRef.current()
    }, DEBOUNCE_MS)
  }, [])

  // ── Layer 1: Global capture-phase error listener for <img> elements ──
  useEffect(() => {
    if (!enabled) return

    const handleError = (e: Event) => {
      const target = e.target
      if (!(target instanceof HTMLImageElement)) return

      const src = target.src || target.currentSrc || ''
      if (!isContentApiUrl(src)) return

      triggerRefresh()
    }

    document.addEventListener('error', handleError, true) // capture phase

    return () => {
      document.removeEventListener('error', handleError, true)
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [enabled, triggerRefresh])

  // ── Layer 2: Proactive periodic refresh ──
  useEffect(() => {
    if (!enabled) return

    const interval = Math.max(refreshIntervalMs, MIN_REFRESH_INTERVAL_MS)

    const intervalId = setInterval(() => {
      onRefreshRef.current()
    }, interval)

    return () => clearInterval(intervalId)
  }, [enabled, refreshIntervalMs])

  // ── Layer 3: Refresh on visibility change (user returns from AFK) ──
  useEffect(() => {
    if (!enabled) return

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = Date.now()
        return
      }

      // Tab became visible — only refresh if it was hidden long enough
      if (lastHiddenAtRef.current > 0) {
        const awayMs = Date.now() - lastHiddenAtRef.current
        lastHiddenAtRef.current = 0
        if (awayMs >= MIN_AWAY_MS) {
          // Small delay to let other state / network settle
          setTimeout(() => onRefreshRef.current(), 500)
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [enabled])

  // ── Layer 4: Sleep/throttle detection via wall-clock heartbeat ──
  // A visible tab on a sleeping machine never fires visibilitychange or focus, and
  // the Layer 2 interval is suspended while asleep. We tick on a short interval and
  // compare wall-clock elapsed time against the expected interval — a large overshoot
  // means the device was asleep / throttled, so we refresh as soon as it wakes.
  useEffect(() => {
    if (!enabled) return

    let lastTick = Date.now()
    const intervalId = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (gap > SLEEP_GAP_MS) {
        onRefreshRef.current()
      }
    }, HEARTBEAT_INTERVAL_MS)

    return () => clearInterval(intervalId)
  }, [enabled])
}
