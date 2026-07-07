'use client'

/**
 * Zoomed subtitle timeline strip (desktop only) — rendered under the video
 * player while subtitle edit mode is active. Shows a 10/30/60s window over
 * the worker-generated audio waveform with draggable/resizable cue blocks.
 *
 * Interaction model:
 *  - drag a block body   → move (duration preserved, clamped vs neighbours)
 *  - drag a block edge   → retime that edge (min 200ms)
 *  - click a block       → select (list scrolls via shared selection)
 *  - double-click block  → split at that position
 *  - drag/wheel elsewhere→ pan (disengages follow)
 *  - click the ruler     → seek
 * Drags live-preview locally and commit ONCE on pointerup (one undo entry).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Crosshair } from 'lucide-react'
import { cn } from '@/lib/utils'
import { clampCueTiming, type EditorCue } from '@/lib/subtitle-edit'
import type { SubtitleEditorApi } from '@/hooks/useSubtitleEditor'

const ZOOM_OPTIONS = [10, 30, 60] as const
const CLICK_THRESHOLD_PX = 4
const LANE_HEIGHT_PX = 88
const RULER_HEIGHT_PX = 20

// Timeline cue colours — the app primary blue (209 100% 60%), strengthened for
// contrast against the now-neutral waveform: heavier fill, a brighter border/ring,
// and an active state that's brighter still. A dedicated set (not the raw
// `--primary` utilities) so the border/ring can be a lighter shade for pop.
const CUE_FILL = 'hsl(209 100% 60% / 0.28)'
const CUE_BORDER = 'hsl(209 100% 72% / 0.9)'
const CUE_ACTIVE_FILL = 'hsl(209 100% 62% / 0.44)'
const CUE_ACTIVE_BORDER = 'hsl(209 100% 76%)'
const CUE_DRAG_FILL = 'hsl(209 100% 64% / 0.5)'
const CUE_DRAG_BORDER = 'hsl(209 100% 80%)'
const CUE_SELECTED_RING = 'hsl(209 100% 70%)'
// Waveform: neutral slate at low alpha so it recedes behind the coloured cues.
const WAVEFORM_COLOR = 'hsl(215 16% 60%)'
const WAVEFORM_ALPHA = 0.45

type DragState =
  | { kind: 'move'; cueId: string; grabOffsetMs: number; origStartMs: number; origEndMs: number; startClientX: number; moved: boolean }
  | { kind: 'resize-start' | 'resize-end'; cueId: string; origStartMs: number; origEndMs: number; startClientX: number; moved: boolean }
  | { kind: 'pan'; startClientX: number; startWindowStartSec: number; moved: boolean; onRuler: boolean }
  | null

function majorTickStep(windowSec: number): number {
  if (windowSec <= 10) return 1
  if (windowSec <= 30) return 5
  return 10
}

function formatTick(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function SubtitleTimelineStrip({ editor }: { editor: SubtitleEditorApi }) {
  const durationSec = Math.max(0.001, editor.durationMs / 1000)
  const [windowSec, setWindowSec] = useState<number>(30)
  const [windowStartSec, setWindowStartSec] = useState(0)
  const [following, setFollowing] = useState(true)
  const [dragPreview, setDragPreview] = useState<{ cueId: string; startMs: number; endMs: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState>(null)
  const laneRectRef = useRef<DOMRect | null>(null)
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollDragRef = useRef<{ grabOffsetPx: number } | null>(null)
  const [widthPx, setWidthPx] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidthPx(el.getBoundingClientRect().width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const effectiveWindowSec = Math.min(windowSec, Math.max(1, durationSec))
  const pxPerSec = widthPx > 0 ? widthPx / effectiveWindowSec : 0

  const clampWindowStart = useCallback(
    (s: number) => Math.min(Math.max(0, s), Math.max(0, durationSec - effectiveWindowSec)),
    [durationSec, effectiveWindowSec],
  )

  const timeToX = useCallback((tSec: number) => (tSec - windowStartSec) * pxPerSec, [windowStartSec, pxPerSec])
  const xToTimeSec = useCallback((x: number) => windowStartSec + x / (pxPerSec || 1), [windowStartSec, pxPerSec])

  const currentTimeSec = editor.currentTimeMs / 1000

  // Follow playback: keep the playhead around 30% of the window; only re-pan
  // when it leaves [10%, 70%] (hysteresis vs the 250ms event cadence).
  useEffect(() => {
    if (!following) return
    const lo = windowStartSec + effectiveWindowSec * 0.1
    const hi = windowStartSec + effectiveWindowSec * 0.7
    if (currentTimeSec < lo || currentTimeSec > hi) {
      setWindowStartSec(clampWindowStart(currentTimeSec - effectiveWindowSec * 0.3))
    }
  }, [currentTimeSec, following, windowStartSec, effectiveWindowSec, clampWindowStart])

  // Zoom change anchors the playhead when visible, else the window centre
  const changeZoom = useCallback((newWindowSec: number) => {
    setWindowSec(newWindowSec)
    const newWin = Math.min(newWindowSec, Math.max(1, durationSec))
    const playheadVisible = currentTimeSec >= windowStartSec && currentTimeSec <= windowStartSec + effectiveWindowSec
    const anchor = playheadVisible ? currentTimeSec : windowStartSec + effectiveWindowSec / 2
    const ratio = playheadVisible ? (currentTimeSec - windowStartSec) / effectiveWindowSec : 0.5
    const next = anchor - newWin * ratio
    setWindowStartSec(Math.min(Math.max(0, next), Math.max(0, durationSec - newWin)))
  }, [currentTimeSec, windowStartSec, effectiveWindowSec, durationSec])

  // ---------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const lane = laneRef.current
    if (!lane || pxPerSec <= 0) return
    laneRectRef.current = lane.getBoundingClientRect()
    const localX = e.clientX - laneRectRef.current.left

    const target = e.target as HTMLElement
    const blockEl = target.closest('[data-cue-id]') as HTMLElement | null
    const onRuler = !!target.closest('[data-strip-ruler]')

    if (blockEl && !onRuler) {
      const cueId = blockEl.dataset.cueId!
      const cue = editor.cues.find((c) => c.id === cueId)
      if (!cue) return
      const isLeftEdge = !!target.closest('[data-edge="start"]')
      const isRightEdge = !!target.closest('[data-edge="end"]')
      editor.selectCue(cueId) // no seek — playback undisturbed
      if (isLeftEdge || isRightEdge) {
        dragRef.current = {
          kind: isLeftEdge ? 'resize-start' : 'resize-end',
          cueId, origStartMs: cue.startMs, origEndMs: cue.endMs,
          startClientX: e.clientX, moved: false,
        }
      } else {
        dragRef.current = {
          kind: 'move',
          cueId,
          grabOffsetMs: Math.round(xToTimeSec(localX) * 1000) - cue.startMs,
          origStartMs: cue.startMs, origEndMs: cue.endMs,
          startClientX: e.clientX, moved: false,
        }
      }
    } else {
      dragRef.current = { kind: 'pan', startClientX: e.clientX, startWindowStartSec: windowStartSec, moved: false, onRuler }
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [editor, pxPerSec, windowStartSec, xToTimeSec])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    const rect = laneRectRef.current
    if (!drag || !rect || pxPerSec <= 0) return
    if (Math.abs(e.clientX - drag.startClientX) >= CLICK_THRESHOLD_PX) drag.moved = true
    if (!drag.moved) return

    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startClientX
      setFollowing(false)
      setWindowStartSec(clampWindowStart(drag.startWindowStartSec - dx / pxPerSec))
      return
    }

    const localX = e.clientX - rect.left
    const xMs = Math.round((windowStartSec + localX / pxPerSec) * 1000)
    let proposed: { startMs: number; endMs: number }
    if (drag.kind === 'move') {
      const startMs = xMs - drag.grabOffsetMs
      proposed = { startMs, endMs: startMs + (drag.origEndMs - drag.origStartMs) }
    } else if (drag.kind === 'resize-start') {
      proposed = { startMs: xMs, endMs: drag.origEndMs }
    } else {
      proposed = { startMs: drag.origStartMs, endMs: xMs }
    }
    const clamped = editor.clampPreview(drag.cueId, proposed, drag.kind)
    setDragPreview({ cueId: drag.cueId, ...clamped })
  }, [editor, pxPerSec, windowStartSec, clampWindowStart])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    const rect = laneRectRef.current
    setDragPreview((preview) => {
      if (drag && drag.kind !== 'pan' && drag.moved && preview && preview.cueId === drag.cueId) {
        // Commit once → one undo entry
        editor.retimeCue(drag.cueId, { startMs: preview.startMs, endMs: preview.endMs }, drag.kind)
      }
      return null
    })
    // A click (no drag) anywhere on the strip — the ruler, a cue block, or empty
    // lane — seeks the playhead to the time under the cursor (cue blocks are also
    // selected, in pointerdown). A drag never seeks.
    if (drag && !drag.moved && rect && pxPerSec > 0) {
      const localX = e.clientX - rect.left
      editor.seekTo(Math.round((windowStartSec + localX / pxPerSec) * 1000))
    }
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* released */ }
  }, [editor, pxPerSec, windowStartSec])

  const onPointerCancel = useCallback(() => {
    dragRef.current = null
    setDragPreview(null)
  }, [])

  // ---------------------------------------------------------------------
  // Scrollbar (position indicator) — click/drag to pan the window
  // ---------------------------------------------------------------------
  const scrollFromClientX = useCallback((clientX: number, grabOffsetPx: number) => {
    const bar = scrollbarRef.current
    if (!bar || durationSec <= 0) return
    const rect = bar.getBoundingClientRect()
    const thumbW = Math.min(rect.width, (effectiveWindowSec / durationSec) * rect.width)
    const maxLeft = Math.max(0, rect.width - thumbW)
    const desiredLeft = Math.min(Math.max(0, clientX - rect.left - grabOffsetPx), maxLeft)
    const maxStart = Math.max(0, durationSec - effectiveWindowSec)
    const startSec = maxLeft > 0 ? (desiredLeft / maxLeft) * maxStart : 0
    setFollowing(false)
    setWindowStartSec(clampWindowStart(startSec))
  }, [durationSec, effectiveWindowSec, clampWindowStart])

  const onScrollbarPointerDown = useCallback((e: React.PointerEvent) => {
    const bar = scrollbarRef.current
    if (!bar || durationSec <= 0) return
    const rect = bar.getBoundingClientRect()
    const thumbW = Math.min(rect.width, (effectiveWindowSec / durationSec) * rect.width)
    const thumbLeft = (windowStartSec / Math.max(0.001, durationSec)) * rect.width
    const clickX = e.clientX - rect.left
    // Grab the thumb where clicked; a track click centers the thumb under the cursor.
    const onThumb = clickX >= thumbLeft && clickX <= thumbLeft + thumbW
    const grabOffset = onThumb ? clickX - thumbLeft : thumbW / 2
    scrollDragRef.current = { grabOffsetPx: grabOffset }
    scrollFromClientX(e.clientX, grabOffset)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }, [durationSec, effectiveWindowSec, windowStartSec, scrollFromClientX])

  const onScrollbarPointerMove = useCallback((e: React.PointerEvent) => {
    if (!scrollDragRef.current) return
    scrollFromClientX(e.clientX, scrollDragRef.current.grabOffsetPx)
  }, [scrollFromClientX])

  const onScrollbarPointerUp = useCallback((e: React.PointerEvent) => {
    scrollDragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* released */ }
  }, [])

  // Wheel over the strip pans it — and must NOT scroll the browser. This matters
  // on the admin share page, where the editor area is 100dvh beneath a fixed
  // header, so a stray page scroll pushes the header/content out of view. React
  // attaches `wheel` as a PASSIVE root listener, so preventDefault() inside an
  // onWheel prop is a no-op; we attach a native non-passive listener instead.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (pxPerSec <= 0) return
      // Trap the wheel over the whole strip so the page never scrolls under it.
      e.preventDefault()
      const delta = e.shiftKey ? e.deltaY : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)
      if (delta === 0) return
      setFollowing(false)
      setWindowStartSec((s) => clampWindowStart(s + delta / pxPerSec))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [pxPerSec, clampWindowStart])

  // ---------------------------------------------------------------------
  // Waveform canvas
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Fall back to the element's own laid-out width so a racing ResizeObserver
    // measurement can never starve the draw (canvas ops are cheap — draw
    // synchronously rather than through a cancellable rAF).
    const cssW = Math.round(widthPx > 0 ? widthPx : canvas.getBoundingClientRect().width)
    if (cssW <= 0) return
    {
      const dpr = window.devicePixelRatio || 1
      const cssH = LANE_HEIGHT_PX
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, cssW, cssH)
      const peaks = editor.peaks
      if (!peaks || peaks.peaks.length === 0) return
      const mid = cssH / 2
      const amp = cssH * 0.45
      // Derive px/sec from the width we actually drew at (not the possibly-stale
      // component pxPerSec) so time↔pixel mapping is always valid.
      const localPxPerSec = cssW / effectiveWindowSec

      // Sample one amplitude per pixel: when zoomed OUT (many buckets per pixel)
      // take the max over the covered span for a full-bodied shape; when zoomed
      // IN (fewer buckets than pixels) interpolate linearly for a smooth curve.
      const bucketsPerPixel = peaks.peaksPerSecond / localPxPerSec
      const heights: number[] = new Array(cssW + 1)
      for (let x = 0; x <= cssW; x++) {
        const t = windowStartSec + x / localPxPerSec
        let v = 0
        if (t >= 0 && t * 1000 <= peaks.durationMs) {
          if (bucketsPerPixel <= 1) {
            const fb = t * peaks.peaksPerSecond
            const i0 = Math.max(0, Math.floor(fb))
            const i1 = Math.min(peaks.peaks.length - 1, i0 + 1)
            const frac = fb - i0
            v = (peaks.peaks[i0] ?? 0) * (1 - frac) + (peaks.peaks[i1] ?? 0) * frac
          } else {
            const b0 = Math.floor(t * peaks.peaksPerSecond)
            const b1 = Math.floor((windowStartSec + (x + 1) / localPxPerSec) * peaks.peaksPerSecond)
            let m = 0
            for (let b = b0; b <= b1 && b < peaks.peaks.length; b++) {
              const p = peaks.peaks[b]
              if (p > m) m = p
            }
            v = m
          }
        }
        heights[x] = v * amp
      }

      // Filled mirrored envelope (anti-aliased) — smoother than discrete bars.
      ctx.fillStyle = WAVEFORM_COLOR
      ctx.globalAlpha = WAVEFORM_ALPHA
      ctx.beginPath()
      ctx.moveTo(0, mid - heights[0])
      for (let x = 1; x <= cssW; x++) ctx.lineTo(x, mid - heights[x])
      for (let x = cssW; x >= 0; x--) ctx.lineTo(x, mid + heights[x])
      ctx.closePath()
      ctx.fill()
    }
  }, [editor.peaks, windowStartSec, effectiveWindowSec, widthPx, pxPerSec])

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const visibleCues = useMemo(() => {
    const winStartMs = (windowStartSec - 1) * 1000
    const winEndMs = (windowStartSec + effectiveWindowSec + 1) * 1000
    return editor.cues.filter((c) => c.endMs >= winStartMs && c.startMs <= winEndMs)
  }, [editor.cues, windowStartSec, effectiveWindowSec])

  const ticks = useMemo(() => {
    const step = majorTickStep(effectiveWindowSec)
    const first = Math.ceil(windowStartSec / step) * step
    const out: number[] = []
    for (let t = first; t <= windowStartSec + effectiveWindowSec; t += step) out.push(t)
    return out
  }, [windowStartSec, effectiveWindowSec])

  function blockGeometry(cue: EditorCue) {
    const isDragging = dragPreview?.cueId === cue.id
    const startMs = isDragging ? dragPreview.startMs : cue.startMs
    const endMs = isDragging ? dragPreview.endMs : cue.endMs
    return {
      left: timeToX(startMs / 1000),
      width: Math.max(2, ((endMs - startMs) / 1000) * pxPerSec),
      isDragging,
    }
  }

  const playheadX = timeToX(currentTimeSec)

  return (
    <div ref={containerRef} className="mt-2 select-none">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-muted-foreground">
          Drag captions to retime · drag edges to resize
          {editor.peaks === null && editor.isAdmin && (
            <span className="text-muted-foreground/70"> · no waveform for this video — Regenerate subtitles to create one</span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {ZOOM_OPTIONS.map((z) => (
            <Button
              key={z}
              type="button"
              variant="outline"
              size="sm"
              className={cn('h-6 px-2 text-[11px]', windowSec === z && 'bg-primary/10 border-primary/50 text-primary')}
              onClick={() => changeZoom(z)}
            >
              {z}s
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={following ? 'Following playback — click to stop' : 'Follow playback'}
            aria-label={following ? 'Stop following playback' : 'Follow playback'}
            aria-pressed={following}
            className={cn('h-6 px-2 text-[11px]', following && 'bg-primary/10 border-primary/50 text-primary')}
            onClick={() => {
              if (following) {
                setFollowing(false)
              } else {
                setFollowing(true)
                setWindowStartSec(clampWindowStart(currentTimeSec - effectiveWindowSec * 0.3))
              }
            }}
          >
            <Crosshair className="w-3 h-3 mr-1" /> Follow
          </Button>
        </div>
      </div>

      <div
        className="relative rounded-md border border-border bg-card overflow-hidden"
        style={{ height: RULER_HEIGHT_PX + LANE_HEIGHT_PX, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {/* Ruler */}
        <div data-strip-ruler className="absolute inset-x-0 top-0 border-b border-border/60 cursor-pointer" style={{ height: RULER_HEIGHT_PX }}>
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 bottom-0" style={{ left: timeToX(t) }}>
              <div className="w-px h-full bg-border" />
              <span className="absolute top-0.5 left-1 text-[9px] text-muted-foreground tabular-nums">{formatTick(t)}</span>
            </div>
          ))}
        </div>

        {/* Lane */}
        <div ref={laneRef} className="absolute inset-x-0 bottom-0 text-foreground" style={{ height: LANE_HEIGHT_PX }}>
          <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />

          {visibleCues.map((cue) => {
            const geo = blockGeometry(cue)
            const isSelected = editor.selectedCueId === cue.id
            const isActive = editor.activeCueId === cue.id
            return (
              <div
                key={cue.id}
                data-cue-id={cue.id}
                className="absolute top-2 bottom-2 rounded border cursor-grab active:cursor-grabbing overflow-hidden"
                style={{
                  left: geo.left,
                  width: geo.width,
                  background: geo.isDragging ? CUE_DRAG_FILL : isActive ? CUE_ACTIVE_FILL : CUE_FILL,
                  borderColor: geo.isDragging ? CUE_DRAG_BORDER : isActive ? CUE_ACTIVE_BORDER : CUE_BORDER,
                  boxShadow: isSelected ? `0 0 0 2px ${CUE_SELECTED_RING}` : undefined,
                }}
              >
                <div data-edge="start" className="absolute inset-y-0 left-0 w-[6px] cursor-ew-resize bg-[hsl(209_100%_62%/0.5)] hover:bg-[hsl(209_100%_70%/0.85)]" />
                <span className={cn(
                  'leading-tight text-white px-2 py-1 pointer-events-none whitespace-normal break-words line-clamp-3 [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]',
                  // The 10s zoom leaves plenty of room in each block — bump the size up.
                  effectiveWindowSec <= 10 ? 'text-[13px]' : 'text-[10px]',
                )}>
                  {cue.text.replace(/\s*\n\s*/g, ' ')}
                </span>
                <div data-edge="end" className="absolute inset-y-0 right-0 w-[6px] cursor-ew-resize bg-[hsl(209_100%_62%/0.5)] hover:bg-[hsl(209_100%_70%/0.85)]" />
              </div>
            )
          })}
        </div>

        {/* Playhead */}
        {playheadX >= 0 && playheadX <= widthPx && (
          <div className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-10" style={{ left: playheadX }} />
        )}
      </div>

      {/* Scrollbar: click the track or drag the thumb to pan the window */}
      <div
        ref={scrollbarRef}
        onPointerDown={onScrollbarPointerDown}
        onPointerMove={onScrollbarPointerMove}
        onPointerUp={onScrollbarPointerUp}
        onPointerCancel={onScrollbarPointerUp}
        className="relative h-2 mt-1 rounded bg-muted/40 cursor-pointer touch-none"
      >
        <div
          className="absolute h-full rounded bg-primary/50 hover:bg-primary/70 transition-colors cursor-grab active:cursor-grabbing"
          style={{
            left: `${(windowStartSec / Math.max(0.001, durationSec)) * 100}%`,
            width: `${Math.min(100, (effectiveWindowSec / Math.max(0.001, durationSec)) * 100)}%`,
          }}
        />
      </div>
    </div>
  )
}
