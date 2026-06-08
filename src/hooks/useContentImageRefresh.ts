'use client'

import { useEffect, useRef, useCallback } from 'react'

const CONTENT_API_PATH = '/api/content/'
const DEBOUNCE_MS = 2_000
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes floor
const MIN_AWAY_MS = 30_000 // Only refresh on visibility if tab was hidden >30s

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
}
