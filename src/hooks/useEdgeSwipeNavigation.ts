import { useEffect, useRef } from 'react'

export interface EdgeSwipeNavigationOptions {
  /** Fired when the user drags inward from the LEFT screen edge toward the right. */
  onSwipeRight?: () => void
  /** Fired when the user drags inward from the RIGHT screen edge toward the left. */
  onSwipeLeft?: () => void
  /** Max distance (px) from the screen edge where a qualifying swipe may start. */
  edgeSize?: number
  /** Min horizontal distance (px) the finger must travel to trigger navigation. */
  threshold?: number
  /** Max vertical drift (px) tolerated before the gesture is treated as a scroll. */
  maxVerticalDrift?: number
  /** Disable the gesture entirely. */
  enabled?: boolean
}

/**
 * Edge-anchored horizontal swipe navigation for touch devices.
 *
 * Only gestures that *begin* within `edgeSize` of the left or right screen edge
 * are tracked, which keeps the gesture from hijacking interior horizontally
 * scrollable surfaces (video scrubber, wide tables, sliders). A left-edge drag
 * to the right invokes `onSwipeRight` (move forward); a right-edge drag to the
 * left invokes `onSwipeLeft` (move back). No-ops on fine-pointer (desktop)
 * devices.
 */
export function useEdgeSwipeNavigation({
  onSwipeRight,
  onSwipeLeft,
  edgeSize = 32,
  threshold = 70,
  maxVerticalDrift = 60,
  enabled = true,
}: EdgeSwipeNavigationOptions) {
  // Keep the latest callbacks without re-binding the document listeners.
  const handlers = useRef({ onSwipeRight, onSwipeLeft })
  useEffect(() => {
    handlers.current = { onSwipeRight, onSwipeLeft }
  }, [onSwipeRight, onSwipeLeft])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    // Touch-capable devices only — skip mouse/desktop.
    if (!window.matchMedia('(pointer: coarse)').matches) return

    let startX = 0
    let startY = 0
    let fromLeftEdge = false
    let fromRightEdge = false
    let tracking = false

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false
        return
      }
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      const w = window.innerWidth
      fromLeftEdge = startX <= edgeSize
      fromRightEdge = startX >= w - edgeSize
      tracking = fromLeftEdge || fromRightEdge
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      // Must be a deliberate, predominantly horizontal flick.
      if (Math.abs(dy) > maxVerticalDrift) return
      if (Math.abs(dx) < threshold) return
      if (Math.abs(dx) <= Math.abs(dy)) return

      if (dx > 0 && fromLeftEdge) {
        handlers.current.onSwipeRight?.()
      } else if (dx < 0 && fromRightEdge) {
        handlers.current.onSwipeLeft?.()
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [enabled, edgeSize, threshold, maxVerticalDrift])
}
