import { useEffect, useRef } from 'react'
import {
  SWIPE_OUT_MS,
  isSwipePending,
  prefersReducedMotion,
  setPendingSwipe,
} from '@/lib/swipe-page-transition'

export interface EdgeSwipeNavigationOptions {
  /** Fired when the user drags inward from the LEFT screen edge toward the right. */
  onSwipeRight?: () => void
  /** Fired when the user drags inward from the RIGHT screen edge toward the left. */
  onSwipeLeft?: () => void
  /** Max distance (px) from the screen edge where a qualifying swipe may start. */
  edgeSize?: number
  /** Min horizontal distance (px) the finger must travel to commit the navigation. */
  threshold?: number
  /** Disable the gesture entirely. */
  enabled?: boolean
  /**
   * Id of the element translated during the drag to give live "the page is
   * moving" feedback. Defaults to the admin layout content surface.
   */
  surfaceId?: string
}

/**
 * Edge-anchored horizontal swipe navigation for touch devices, with live drag
 * feedback and an iOS-style push/pop page transition.
 *
 * Only gestures that *begin* within `edgeSize` of the left or right screen edge
 * are tracked, which keeps the gesture from hijacking interior horizontally
 * scrollable surfaces (video scrubber, wide tables, sliders). While dragging,
 * the surface element follows the finger so the movement is visible; releasing
 * past `threshold` slides the page off-screen and commits the matching callback
 * (the incoming page's slide-in is handed off to the admin layout via
 * swipe-page-transition), otherwise the page springs back. A left-edge drag to
 * the right invokes `onSwipeRight`; a right-edge drag to the left invokes
 * `onSwipeLeft`. No-ops on fine-pointer (desktop) devices.
 */
export function useEdgeSwipeNavigation({
  onSwipeRight,
  onSwipeLeft,
  edgeSize = 32,
  threshold = 70,
  enabled = true,
  surfaceId = 'admin-content-surface',
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
    let allowedDir = 0 // +1 = page may follow finger right, -1 = left
    let tracking = false // qualifying edge gesture in progress
    let dragging = false // horizontal intent confirmed, surface is following
    let lastDx = 0
    let rafId = 0

    const RESISTANCE = 0.85
    const INTENT_DISTANCE = 10

    const surface = () => document.getElementById(surfaceId)

    const applyTransform = (px: number) => {
      const el = surface()
      if (!el) return
      el.style.transform = px === 0 ? '' : `translateX(${px}px)`
    }

    const springBack = () => {
      const el = surface()
      if (!el) return
      el.style.transition = 'transform 200ms ease-out'
      el.style.transform = 'translateX(0px)'
      const cleanup = () => {
        el.style.transition = ''
        el.style.transform = ''
        el.removeEventListener('transitionend', cleanup)
      }
      el.addEventListener('transitionend', cleanup)
      window.setTimeout(cleanup, 240)
    }

    const reset = () => {
      tracking = false
      dragging = false
      allowedDir = 0
      lastDx = 0
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const begin = (clientX: number, clientY: number) => {
      startX = clientX
      startY = clientY
      const w = window.innerWidth
      if (startX <= edgeSize && handlers.current.onSwipeRight) {
        allowedDir = 1
      } else if (startX >= w - edgeSize && handlers.current.onSwipeLeft) {
        allowedDir = -1
      } else {
        reset()
        return
      }
      tracking = true
      dragging = false
      lastDx = 0
      // Cancel any in-flight spring-back so the new drag starts clean.
      const el = surface()
      if (el) el.style.transition = ''
    }

    const move = (clientX: number, clientY: number, preventDefault: () => void) => {
      if (!tracking) return
      const dx = clientX - startX
      const dy = clientY - startY

      if (!dragging) {
        // Treat a predominantly vertical move as a scroll and bail out.
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > INTENT_DISTANCE) {
          reset()
          return
        }
        // Claim the gesture once it has moved far enough in the allowed direction.
        if (Math.sign(dx) === allowedDir && Math.abs(dx) > INTENT_DISTANCE) {
          dragging = true
        } else {
          return
        }
      }

      // Follow the finger only in the allowed direction, with light resistance.
      const travel = Math.sign(dx) === allowedDir ? dx * RESISTANCE : 0
      lastDx = dx
      // Now that we own the gesture, stop the browser from scrolling under it.
      preventDefault()
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => applyTransform(travel))
    }

    const navigate = (dir: number) => {
      if (dir > 0) handlers.current.onSwipeRight?.()
      else handlers.current.onSwipeLeft?.()
    }

    // Continue the page off-screen in the drag direction, then navigate. The
    // incoming page's slide-in is handed off to the persistent admin layout
    // via setPendingSwipe (see swipe-page-transition + admin/layout).
    const commit = (dir: number) => {
      const el = surface()
      if (!el || prefersReducedMotion()) {
        applyTransform(0)
        navigate(dir)
        return
      }
      setPendingSwipe(dir as 1 | -1)
      const w = window.innerWidth
      el.style.transition = `transform ${SWIPE_OUT_MS}ms ease-in`
      el.style.transform = `translateX(${dir * w}px)`
      let done = false
      const finish = () => {
        if (done) return
        done = true
        el.removeEventListener('transitionend', finish)
        // Leave the surface off-screen — the layout takes over the entrance.
        navigate(dir)
      }
      el.addEventListener('transitionend', finish)
      window.setTimeout(finish, SWIPE_OUT_MS + 60)
    }

    const end = () => {
      if (!tracking) return
      const dir = allowedDir
      const dx = lastDx
      const committed = dragging && Math.sign(dx) === dir && Math.abs(dx) >= threshold
      reset()

      if (committed) commit(dir)
      else springBack()
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        reset()
        return
      }
      const t = e.touches[0]
      begin(t.clientX, t.clientY)
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      move(t.clientX, t.clientY, () => e.preventDefault())
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', end, { passive: true })
    document.addEventListener('touchcancel', end, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
      if (rafId) cancelAnimationFrame(rafId)
      // Restore the shared surface in case we unmount mid-gesture — but NOT
      // when a swipe commit is mid-flight: it deliberately leaves the surface
      // off-screen for the layout to slide the next page in.
      if (!isSwipePending()) {
        const el = surface()
        if (el) {
          el.style.transition = ''
          el.style.transform = ''
        }
      }
    }
  }, [enabled, edgeSize, threshold, surfaceId])
}
