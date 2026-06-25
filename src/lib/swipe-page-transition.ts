/**
 * Coordinates the two halves of the mobile edge-swipe page transition.
 *
 * The outgoing page (which owns the gesture via `useEdgeSwipeNavigation`) slides
 * itself off-screen and then navigates — at which point it unmounts. The
 * incoming page can't animate itself in from there, so the entrance is driven
 * from the persistent admin layout surface instead. The two are linked by a
 * one-shot "pending direction" set on commit and consumed by the layout once
 * the new route mounts.
 *
 * Direction convention (`dir`): the sign the *outgoing* page travelled.
 *   +1 = dragged right  → back/pop  → new page enters from the LEFT edge.
 *   -1 = dragged left   → forward/push → new page enters from the RIGHT edge.
 */

export const SWIPE_SURFACE_ID = 'admin-content-surface'
export const SWIPE_OUT_MS = 200
export const SWIPE_IN_MS = 240

let pendingDir: 1 | -1 | 0 = 0

export function setPendingSwipe(dir: 1 | -1) {
  pendingDir = dir
}

/** Read and clear the pending direction (0 if none). */
export function consumePendingSwipe(): 1 | -1 | 0 {
  const d = pendingDir
  pendingDir = 0
  return d
}

export function isSwipePending(): boolean {
  return pendingDir !== 0
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function getSwipeSurface(id: string = SWIPE_SURFACE_ID): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(id)
}

/**
 * Slide the freshly-mounted page in from the opposite edge to rest. Called by
 * the admin layout when a route change carried a pending swipe direction.
 */
export function runSwipeEntrance(dir: 1 | -1, id: string = SWIPE_SURFACE_ID) {
  const el = getSwipeSurface(id)
  if (!el) return

  if (prefersReducedMotion()) {
    el.style.transition = ''
    el.style.transform = ''
    return
  }

  const w = window.innerWidth
  // Jump to the opposite edge (off-screen, invisible) without animating...
  el.style.transition = 'none'
  el.style.transform = `translateX(${-dir * w}px)`
  // ...force a reflow so the next change actually transitions...
  void el.offsetWidth
  // ...then settle into place.
  el.style.transition = `transform ${SWIPE_IN_MS}ms ease-out`
  el.style.transform = 'translateX(0px)'

  const cleanup = () => {
    el.style.transition = ''
    el.style.transform = ''
    el.removeEventListener('transitionend', cleanup)
  }
  el.addEventListener('transitionend', cleanup)
  window.setTimeout(cleanup, SWIPE_IN_MS + 60)
}
