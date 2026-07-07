import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'

// Shared width for the right-hand share-page panel. The Comment Display / subtitle
// editor (ShareFeedbackGrid) and the Project Activity panel are never mounted at the
// same time, so persisting to one localStorage key keeps their widths in sync: each
// reads it on mount and writes it on resize.
const STORAGE_KEY = 'share_comments_width'
const MIN_WIDTH = 380
const DEFAULT_WIDTH = 420
const MAX_VIEWPORT_FRACTION = 0.6

export function useResizableSidePanel() {
  const [isDesktop, setIsDesktop] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  // Attach to the panel wrapper — its right edge anchors the drag calculation.
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Load the shared saved width (desktop only).
  useEffect(() => {
    if (!isDesktop) return
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return
    const w = parseInt(saved, 10)
    if (Number.isFinite(w) && w >= MIN_WIDTH && w <= window.innerWidth * MAX_VIEWPORT_FRACTION) {
      setWidth(w)
    }
  }, [isDesktop])

  // Keep within 60% of the viewport when the window shrinks.
  useEffect(() => {
    if (!isDesktop) return
    const onResize = () =>
      setWidth((prev) => {
        const max = Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION)
        return prev > max ? max : prev
      })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isDesktop])

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      if (!isResizing || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const next = rect.right - e.clientX
      const max = Math.min(window.innerWidth * MAX_VIEWPORT_FRACTION, rect.right * 0.9)
      setWidth(Math.max(MIN_WIDTH, Math.min(max, next)))
    }
    const onUp = () => {
      if (!isResizing) return
      setIsResizing(false)
      setWidth((w) => {
        localStorage.setItem(STORAGE_KEY, Math.round(w).toString())
        return w
      })
    }
    if (isResizing) {
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      if (!isDesktop) return
      e.preventDefault()
      setIsResizing(true)
    },
    [isDesktop],
  )

  return { width, isDesktop, isResizing, startResize, containerRef }
}
