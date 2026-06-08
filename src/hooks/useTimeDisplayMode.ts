'use client'

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'vitransfer:vplayer:timeDisplay'
const SYNC_EVENT = 'vitransfer:timeDisplayChanged'

export type TimeDisplayMode = 'duration' | 'timecode'

/**
 * Shared hook for the time display mode toggle.
 *
 * Reads the initial value from localStorage (falling back to the project-level
 * `useFullTimecode` preference).  When the mode is changed, it writes to
 * localStorage and dispatches a custom DOM event so that every component using
 * this hook stays in sync — even across different React sub-trees (VideoPlayer,
 * CommentSectionView, CommentInput).
 */
export function useTimeDisplayMode(
  projectUseFullTimecode: boolean = false,
): {
  timeDisplayMode: TimeDisplayMode
  setTimeDisplayMode: (mode: TimeDisplayMode) => void
} {
  const [timeDisplayMode, setTimeDisplayModeState] = useState<TimeDisplayMode>(() => {
    if (typeof window === 'undefined') return projectUseFullTimecode ? 'timecode' : 'duration'
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'timecode' || stored === 'duration') return stored
    } catch { /* localStorage unavailable */ }
    return projectUseFullTimecode ? 'timecode' : 'duration'
  })

  // Listen for cross-component sync events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mode: TimeDisplayMode } | undefined
      if (detail && (detail.mode === 'duration' || detail.mode === 'timecode')) {
        setTimeDisplayModeState(detail.mode)
      }
    }
    window.addEventListener(SYNC_EVENT, handler)
    return () => window.removeEventListener(SYNC_EVENT, handler)
  }, [])

  const setTimeDisplayMode = useCallback((mode: TimeDisplayMode) => {
    setTimeDisplayModeState(mode)
    try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* noop */ }
    // Notify other components using the same hook
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { mode } }))
  }, [])

  return { timeDisplayMode, setTimeDisplayMode }
}
