
'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import Hls from 'hls.js'
import Image from 'next/image'
import type { Video } from '@/types/video'
// Avoid importing Prisma runtime types in client components.
type ProjectStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'REVIEWED' | 'ON_HOLD' | 'SHARE_ONLY' | 'APPROVED' | 'CLOSED'
import { Button } from './ui/button'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, MessageSquare, Rewind, FastForward, Download, Settings, Loader2, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { cn, formatTimestamp } from '@/lib/utils'
import { timecodeToSeconds, secondsToTimecode } from '@/lib/timecode'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { VideoAssetDownloadModal } from './VideoAssetDownloadModal'
import { useTimeDisplayMode } from '@/hooks/useTimeDisplayMode'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

const DEFAULT_ASPECT_RATIO = 16 / 9

function formatTimestampForDuration(seconds: number, durationSeconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const d = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  if (!d) return formatTimestamp(s)

  const totalSeconds = Math.floor(s)
  const secs = totalSeconds % 60

  // If duration shows hours, always show hours for current time too (H:MM:SS).
  if (d >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  // Duration is MM:SS, so keep current time as MM:SS (pad minutes to 2 digits).
  const minutes = Math.floor(totalSeconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/**
 * Format a timestamp for display, respecting the user's time display mode.
 * - 'duration': MM:SS or H:MM:SS (current behaviour)
 * - 'timecode': HH:MM:SS:FF using the selected video's FPS
 */
function formatTimestampDisplay(
  seconds: number,
  durationSeconds: number,
  fps: number | undefined,
  mode: 'duration' | 'timecode',
): string {
  if (mode === 'timecode' && typeof fps === 'number' && fps > 0) {
    return secondsToTimecode(seconds, fps)
  }
  return formatTimestampForDuration(seconds, durationSeconds)
}

interface VideoPlayerProps {
  videos: Video[]
  projectId: string
  projectStatus: ProjectStatus
  defaultQuality?: '720p' | '1080p' // Default quality from settings
  onApprove?: () => void // Optional approval callback
  projectTitle?: string
  clientName?: string
  isPasswordProtected?: boolean
  isAdmin?: boolean // Admin users can see all versions (default: false for clients)
  isGuest?: boolean // Guest mode - limited view (videos only, no downloads)
  activeVideoName?: string // The video name (for maintaining selection after reload)
  initialSeekTime?: number | null // Initial timestamp to seek to (from URL params)
  initialVideoIndex?: number // Initial video index to select (from URL params)
  shareToken?: string | null
  hideDownloadButton?: boolean // Hide download button completely (for admin share view)

  // Optional: used to render comment markers along the timeline (share page).
  // Expected shape matches Comment (and optionally includes `replies`).
  commentsForTimeline?: any[]

  // Optional: disables comment-related UI (markers, fullscreen comments toggle).
  // Useful for minimal “player-only” viewers.
  disableCommentsUI?: boolean

  // Optional: disables only the fullscreen comments toggle/open behavior.
  // Useful when comments remain visible elsewhere, but leaving new comments is disabled.
  disableFullscreenCommentsUI?: boolean

  // Optional: when true, VideoPlayer will fill its parent height (non-fullscreen)
  // and allow the video area to flex/shrink to fit available space.
  fitToContainerHeight?: boolean

  // Optional: reduce max viewport height (desktop only) to keep controls/input visible.
  viewportHeightOffsetPx?: number

  // Optional: extra spacing under controls (non-fullscreen only).
  controlsBottomPaddingPx?: number

  // Optional: fill the parent container height, centering the video vertically
  // with controls at the bottom. Uses pure CSS flex layout — no viewport-based
  // pixel math. Ideal when the parent already has an explicit height.
  fillContainer?: boolean

  // Optional (fillContainer only): when true, controls pin to the bottom of
  // the container (video fills remaining space). When false/omitted, the video
  // and controls are vertically centered as a group.
  pinControlsToBottom?: boolean

  // Optional (fillContainer only): when true, the mobile max-height stays at
  // 100dvh instead of the default 60dvh. Useful when the player is the only
  // content on the page (e.g. Guest Video Link).
  mobileFullHeight?: boolean

  // Optional: project-level default for time display mode (duration vs timecode).
  // When true, the player defaults to full timecode (HH:MM:SS:FF) display.
  // Users can override this per-device via a local toggle stored in localStorage.
  useFullTimecode?: boolean

  // Optional: when true, shows a small dropdown arrow next to the time display
  // that lets the viewer toggle between Duration (MM:SS) and Timecode (HH:MM:SS:FF).
  // Typically enabled on the share page for client viewing.
  showTimeDisplayToggle?: boolean

  // Optional: when provided (combined share files view), the approved-video
  // Download button closes the player and returns the viewer to the Files browser
  // instead of opening the asset-download modal.
  onCloseVideo?: () => void

  // Optional: invoked when the <video> element fails to load its source (e.g. an
  // expired stream token). The parent can re-mint tokens and feed back fresh URLs.
  // Fired at most once per failed source until a subsequent load succeeds.
  onStreamError?: (videoId: string) => void
}

export default function VideoPlayer({
  videos,
  projectId,
  projectStatus,
  defaultQuality = '720p',
  onApprove,
  projectTitle,
  clientName,
  isPasswordProtected,
  isAdmin = false, // Default to false (client view)
  isGuest = false, // Default to false (full client view)
  activeVideoName,
  initialSeekTime = null,
  initialVideoIndex = 0,
  shareToken = null,
  hideDownloadButton = false, // Default to false (show download button)
  commentsForTimeline = [],
  disableCommentsUI = false,
  disableFullscreenCommentsUI = false,
  fitToContainerHeight = false,
  viewportHeightOffsetPx,
  controlsBottomPaddingPx,
  fillContainer = false,
  pinControlsToBottom = false,
  mobileFullHeight = false,
  useFullTimecode = false, // Default to duration mode
  showTimeDisplayToggle = false, // Default: hide the toggle (admin view)
  onCloseVideo,
  onStreamError,
}: VideoPlayerProps) {
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(initialVideoIndex)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  // YouTube-style double-tap seek + tap feedback overlays. `key` is bumped on each
  // trigger so React remounts the node and the CSS animation replays.
  const [seekIndicator, setSeekIndicator] = useState<
    { side: 'left' | 'right'; amount: number; key: number } | null
  >(null)
  const [centerPulse, setCenterPulse] = useState<{ kind: 'play' | 'pause'; key: number } | null>(null)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState<number>(0)
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState<number>(0)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const lastNonZeroVolumeRef = useRef(1)
  const volumeSliderCloseTimeoutRef = useRef<number | null>(null)
  // Tracks the videoId we've already asked the parent to recover, so a failing source
  // triggers exactly one token-refresh request (cleared once a load succeeds).
  const streamErrorRecoveryRef = useRef<string | null>(null)

  // --- HLS (proxy-robust segmented playback) ---
  // The active hls.js instance (MSE path only). Native-HLS (Safari/iOS) uses the
  // element's own src and needs no instance.
  const hlsInstanceRef = useRef<Hls | null>(null)
  const [hlsLevelsReady, setHlsLevelsReady] = useState(false)
  // Rendition heights parsed from the HLS master (hls.js/MSE only) — the source of truth for
  // the quality menu now that MP4 stream URLs no longer exist.
  const [hlsLevelHeights, setHlsLevelHeights] = useState<number[]>([])
  // Playback-capability probe, resolved client-side on mount. `mse` → hls.js can run
  // (desktop incl. desktop-Safari); `native` → element plays .m3u8 directly (iOS Safari).
  const [hlsSupport, setHlsSupport] = useState<{ mse: boolean; native: boolean }>({ mse: false, native: false })
  const [hlsResolved, setHlsResolved] = useState(false)
  useEffect(() => {
    const probe = document.createElement('video')
    setHlsSupport({
      mse: Hls.isSupported(),
      native: !!probe.canPlayType('application/vnd.apple.mpegurl'),
    })
    setHlsResolved(true)
  }, [])
  const [videoAspectRatio, setVideoAspectRatio] = useState<number>(DEFAULT_ASPECT_RATIO)
  const [showPosterOverlay, setShowPosterOverlay] = useState(true)
  // When a video is opened via a folder click that requests autoplay, we hold the
  // target videoId here so the freshly-mounted <video> element can start playback as
  // soon as it can (onCanPlay) — and so the poster/thumbnail is never shown, even
  // briefly, before the first frame. The paired ref carries the seek time (usually 0).
  const autoPlayRequestRef = useRef<string | null>(null)
  const autoPlaySeekRef = useRef<number>(0)

  const [canShowTimelineHover, setCanShowTimelineHover] = useState(true)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [isLgViewport, setIsLgViewport] = useState(false)
  const [isDesktopControlsNarrow, setIsDesktopControlsNarrow] = useState(false)

  const playerContainerRef = useRef<HTMLDivElement>(null)
  // The inner box that exactly matches the video's aspect ratio. Measured so the
  // sprite-frame overlay shown while (non-precision) scrubbing can be letterboxed
  // to fit the player just like the <video> element.
  const playerFrameBoxRef = useRef<HTMLDivElement>(null)
  const [playerFrameBoxSize, setPlayerFrameBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false)
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false)

  const [showApprovedDownloadOptions, setShowApprovedDownloadOptions] = useState(false)

  // Time display mode: 'duration' (MM:SS) or 'timecode' (HH:MM:SS:FF)
  // Uses a shared hook so the setting syncs with CommentSection / CommentInput.
  const { timeDisplayMode, setTimeDisplayMode } = useTimeDisplayMode(useFullTimecode)
  const [showTimeDisplayMenu, setShowTimeDisplayMenu] = useState(false)

  // Close time display menu on outside click (uses class-based detection to
  // support multiple instances rendered in different control layouts).
  useEffect(() => {
    if (!showTimeDisplayMenu) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.time-display-toggle') && !target.closest('.time-display-menu')) {
        setShowTimeDisplayMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showTimeDisplayMenu])

  const toggleTimeDisplayMode = useCallback((mode: 'duration' | 'timecode') => {
    setTimeDisplayMode(mode)
    setShowTimeDisplayMenu(false)
  }, [setTimeDisplayMode])

  // Quality selector state
  const [selectedQuality, setSelectedQuality] = useState<'auto' | '480p' | '720p' | '1080p'>('auto')
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  const [autoResolvedQuality, setAutoResolvedQuality] = useState<'480p' | '720p' | '1080p'>(defaultQuality as '720p' | '1080p')
  const [isBuffering, setIsBuffering] = useState(false)
  const desktopQualityControlsRef = useRef<HTMLDivElement>(null)
  const mobileQualityControlsRef = useRef<HTMLDivElement>(null)
  const bufferingTimeoutRef = useRef<number | null>(null)
  const suppressAutoDowngradeUntilRef = useRef(0)

  const scrubBarRef = useRef<HTMLDivElement>(null)

  const scrubRafRef = useRef<number | null>(null)
  const pendingScrubClientXRef = useRef<number | null>(null)
  // Distinguish a plain click from a drag: scrubbing visuals (the sprite overlay,
  // live seeking) only engage once the pointer moves past this threshold. A plain
  // click never shows the sprite — it just seeks the <video> once on release, which
  // the browser renders by holding the current frame until the new one decodes, so
  // there's no sprite pop / double flash.
  const scrubStartClientXRef = useRef(0)
  const scrubDidMoveRef = useRef(false)
  const SCRUB_DRAG_THRESHOLD_PX = 4
  // Precision ("fine") dragging: while a timeline drag is active and Shift is held,
  // cursor movement is scaled down so each pixel maps to a fraction of a second
  // instead of (on long videos) several. Anchored to the cursor position where Shift
  // engaged so the marker doesn't jump on press. The anchor lives in a ref because
  // every time computation funnels through getTimeFromScrubEvent (scrub RAF, IN/OUT
  // handle moves, hover preview) and must agree. The state mirror drives the on-screen
  // "fine control" cue. Releasing Shift mid-drag clears the anchor, so the marker snaps
  // back to the raw cursor — that's why the cue tells users to release Shift, not the
  // mouse, to keep their fine-tuned position.
  const precisionDragAnchorRef = useRef<{ clientX: number; time: number } | null>(null)
  const [isPrecisionDragging, setIsPrecisionDragging] = useState(false)
  // When precision (Shift) engages, the real <video> hasn't seeked to the target
  // frame yet, so its last-rendered frame would flash before the seek lands. We
  // keep the sprite overlay up until the first `seeked` fires after engaging —
  // this flips true then, and resets to false whenever precision disengages.
  const [precisionFrameReady, setPrecisionFrameReady] = useState(false)
  // Non-precision release bridge. When a normal (no-Shift) scrub is released, the
  // real <video> hasn't finished seeking to the released frame yet, so dropping the
  // sprite overlay immediately flashes the pre-seek frame. We keep the sprite up
  // until the first `seeked` lands after release (mirrors precisionFrameReady), with
  // a timeout safety net. `scrubSettlingRef` mirrors the state for the (stable)
  // seeked listener; `finishScrubSettleRef` lets that listener call the latest closure.
  const [scrubSettling, setScrubSettling] = useState(false)
  const scrubSettlingRef = useRef(false)
  const scrubSettleTimeoutRef = useRef<number | null>(null)
  const finishScrubSettleRef = useRef<() => void>(() => {})
  // True if precision was engaged at any point during the current scrub gesture.
  // Survives the pointerUp (which clears the anchor) so the trailing click — which
  // would otherwise re-seek the playhead to the raw cursor position — can be skipped,
  // preserving the fine-tuned spot. Reset at the start of each new scrub press.
  const precisionUsedThisGestureRef = useRef(false)
  const [timelineCues, setTimelineCues] = useState<
    Array<{
      start: number
      end: number
      sprite: string
      x: number
      y: number
      w: number
      h: number
    }>
  >([])
  const [timelineHover, setTimelineHover] = useState<{
    visible: boolean
    leftPx: number
    timeSeconds: number
    spriteUrl: string | null
    x: number
    y: number
    w: number
    h: number
  }>({
    visible: false,
    leftPx: 0,
    timeSeconds: 0,
    spriteUrl: null,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  })

  const [timelineCommentHover, setTimelineCommentHover] = useState<{
    visible: boolean
    leftPx: number
    commentId: string | null
  }>({
    visible: false,
    leftPx: 0,
    commentId: null,
  })
  const isScrubbingRef = useRef(false)
  // Whether the playhead is actively being dragged on the scrub bar. State (not
  // just the ref) so the scrub preview can render a primary-coloured frame +
  // "PLAYHEAD POSITION" label, mirroring the comment range-drag cue.
  const [isScrubbingPlayhead, setIsScrubbingPlayhead] = useState(false)
  // Which interactable timeline element the mouse is hovering (not dragging):
  // the playhead thumb, a comment IN/OUT handle, or the "clear range" ✕. Drives
  // the same coloured preview frame as dragging, but anchored to the element's
  // *neutral* stored timecode — the IN/OUT handles are rendered slightly apart
  // for clarity, so their on-screen position doesn't exactly match their true
  // timecode and we must not derive the preview time from the cursor here. The
  // ref lets the scrub bar's pointer-move handler know to leave the preview alone.
  const [hoveredTimelineTarget, setHoveredTimelineTarget] = useState<'playhead' | 'rangeStart' | 'rangeEnd' | 'clear' | null>(null)
  const hoveredTimelineTargetRef = useRef<'playhead' | 'rangeStart' | 'rangeEnd' | 'clear' | null>(null)
  const setHoverTimelineTarget = (target: 'playhead' | 'rangeStart' | 'rangeEnd' | 'clear' | null) => {
    hoveredTimelineTargetRef.current = target
    setHoveredTimelineTarget(target)
  }

  // Comment range selection state (two-handle timeline overlay)
  const [commentRangeActive, setCommentRangeActive] = useState(false)
  const [commentRangeStart, setCommentRangeStart] = useState(0)
  const [commentRangeEnd, setCommentRangeEnd] = useState(0)
  const commentRangeActiveRef = useRef(false)
  const commentRangeStartRef = useRef(0)
  const commentRangeEndRef = useRef(0)
  const commentRangeHasExplicitSelectionRef = useRef(false)
  // True while the point marker is "attached" to the playhead (just activated and
  // not yet moved). When true, the IN/OUT brackets ride the ball so the marker and
  // the timecode above the comment box never disagree. Any deliberate placement —
  // dragging a handle, keyboard-nudging, or typing an exact time — detaches it.
  const commentPointFollowsPlayheadRef = useRef(false)
  const keepTimelineHoverPinnedRef = useRef(false)
  const isRangeFramePreviewActiveRef = useRef(false)
  const rangeFramePreviewOriginalPlayheadRef = useRef<number | null>(null)
  // Canvas used to show the exact live video frame in the timeline preview while
  // dragging a handle / scrubbing (sprites are too coarse for scene changes).
  const previewFrameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const suppressTimelineSeekUntilRef = useRef(0)
  const draggingRangeHandle = useRef<'start' | 'end' | null>(null)
  // Which range handle is actively being dragged — drives the labelled,
  // colour-matched hover preview so clients can see whether they are setting
  // the comment start or end point. State (not just a ref) so the preview re-renders.
  const [activeRangeDragHandle, setActiveRangeDragHandle] = useState<'start' | 'end' | null>(null)
  // Sync ref so event handlers have a non-stale view of active state
  useEffect(() => { commentRangeActiveRef.current = commentRangeActive }, [commentRangeActive])
  useEffect(() => { commentRangeStartRef.current = commentRangeStart }, [commentRangeStart])
  useEffect(() => { commentRangeEndRef.current = commentRangeEnd }, [commentRangeEnd])

  // Safety net for stuck drags. A scrub or range-handle drag clears itself on
  // pointerup/pointercancel, but those events can be lost if focus is stolen
  // mid-drag (a screenshot overlay like Win+Shift+S, alt-tab, etc.). Without a
  // release, the captured pointer keeps "dragging" on plain hover. So we also
  // end any in-progress drag when the window blurs, the tab is hidden, or a
  // pointerup/cancel reaches the window — and self-heal in the move handlers
  // when a "drag" move arrives with no mouse button held (e.buttons === 0).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const endStuckDrags = () => {
      draggingRangeHandle.current = null
      isScrubbingRef.current = false
      keepTimelineHoverPinnedRef.current = false
      precisionDragAnchorRef.current = null
      setActiveRangeDragHandle(null)
      setIsScrubbingPlayhead(false)
      setIsPrecisionDragging(false)
      setPrecisionFrameReady(false)
    }
    const onVisibility = () => { if (document.hidden) endStuckDrags() }
    window.addEventListener('pointerup', endStuckDrags)
    window.addEventListener('pointercancel', endStuckDrags)
    window.addEventListener('blur', endStuckDrags)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pointerup', endStuckDrags)
      window.removeEventListener('pointercancel', endStuckDrags)
      window.removeEventListener('blur', endStuckDrags)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // While *precision* (Shift) dragging a comment IN/OUT handle or scrubbing the
  // playhead, draw the live (already-seeked) video frame into the preview canvas
  // each animation frame, so the timeline preview matches the main player exactly.
  // Non-precision drags (the default) don't seek the video — they show sprite tiles
  // instead (see preview render + the player overlay), so there's nothing live to
  // draw and we skip the rAF loop. Passive hover also keeps using sprites.
  useEffect(() => {
    const isDragging = activeRangeDragHandle !== null || isScrubbingPlayhead
    // Only desktop precision drags render the live-frame canvas; everything else
    // (non-precision drags, touch) shows sprites, so there's nothing to draw.
    if (!isDragging || !isPrecisionDragging || !canShowTimelineHover) return
    let raf = 0
    const draw = () => {
      const video = videoRef.current
      const canvas = previewFrameCanvasRef.current
      if (video && canvas && canvas.width > 0 && video.readyState >= 2) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height) } catch {}
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [activeRangeDragHandle, isScrubbingPlayhead, isPrecisionDragging, canShowTimelineHover])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mql = window.matchMedia('(hover: hover) and (pointer: fine)')
    const update = () => setCanShowTimelineHover(mql.matches)
    update()

    // Safari < 14 uses addListener/removeListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }

    mql.addListener(update)
    return () => mql.removeListener(update)
  }, [])

  useEffect(() => {
    const container = playerContainerRef.current
    if (!container) {
      setIsDesktopControlsNarrow(false)
      return
    }

    const DESKTOP_FRAME_STEP_MIN_WIDTH = 1000
    const update = () => {
      const width = container.clientWidth
      setIsDesktopControlsNarrow(isLgViewport && width > 0 && width < DESKTOP_FRAME_STEP_MIN_WIDTH)
    }

    update()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }

    const observer = new ResizeObserver(() => update())
    observer.observe(container)
    return () => observer.disconnect()
  }, [isLgViewport])

  // Track the rendered size of the aspect-ratio video box so the scrub sprite
  // overlay can be sized/letterboxed to match the <video> exactly.
  useEffect(() => {
    const box = playerFrameBoxRef.current
    if (!box) return
    const update = () => setPlayerFrameBoxSize({ w: box.clientWidth, h: box.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(() => update())
    observer.observe(box)
    return () => observer.disconnect()
    // The box div is rendered unconditionally with the player; the ResizeObserver
    // catches every later size change (layout, fullscreen, viewport), so this only
    // needs to wire up once.
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mql = window.matchMedia('(max-width: 639px)')
    const update = () => setIsMobileViewport(mql.matches)
    update()

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }

    mql.addListener(update)
    return () => mql.removeListener(update)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mql = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsLgViewport(mql.matches)
    update()

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }

    mql.addListener(update)
    return () => mql.removeListener(update)
  }, [])

  const scheduleScrubToClientX = (clientX: number) => {
    pendingScrubClientXRef.current = clientX
    if (scrubRafRef.current != null) return

    scrubRafRef.current = window.requestAnimationFrame(() => {
      scrubRafRef.current = null
      const x = pendingScrubClientXRef.current
      if (x == null) return

      const { time, width } = getTimeFromScrubEvent(x)
      const snapped = snapPlayheadToHandles(time, width)
      if (videoRef.current) {
        // Default (non-precision) drag: don't seek the real video — that fetches
        // full-resolution frames over the network on every move. Just advance the
        // playhead UI; the sprite overlay/hover show the frame. Only a precision
        // (Shift) drag seeks the actual video for an exact frame. The trailing
        // onClick after release lands one final real seek at the snapped position.
        if (precisionDragAnchorRef.current) {
          try {
            videoRef.current.currentTime = snapped
          } catch {
            // ignore
          }
        }
        currentTimeRef.current = snapped
        setCurrentTimeSeconds(snapped)
      }

      // Desktop: hover preview. Mobile/touch: preview while actively scrubbing.
      // Keep the preview frame/time consistent with the snapped playhead.
      if (canShowTimelineHover || isScrubbingRef.current) {
        if (snapped !== time) {
          updateHoverFromTimeSeconds(snapped, undefined, isScrubbingRef.current)
        } else {
          updateHoverFromClientX(x, isScrubbingRef.current)
        }
      }
    })
  }

  const parseVtt = (vttText: string) => {
    const lines = vttText
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim())

    const cues: Array<{ start: number; end: number; sprite: string; x: number; y: number; w: number; h: number }> = []

    const parseTime = (t: string) => {
      // Supports HH:MM:SS.mmm
      const m = t.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
      if (!m) return 0
      const hh = parseInt(m[1], 10)
      const mm = parseInt(m[2], 10)
      const ss = parseInt(m[3], 10)
      const ms = parseInt(m[4], 10)
      return hh * 3600 + mm * 60 + ss + ms / 1000
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const timeLine = lines[i]
      if (!timeLine.includes('-->')) continue

      const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim())
      const start = parseTime(startStr)
      const end = parseTime(endStr)
      const target = lines[i + 1]
      const m = target.match(/^(.+?)#xywh=(\d+),(\d+),(\d+),(\d+)$/)
      if (!m) continue

      cues.push({
        start,
        end,
        sprite: m[1],
        x: parseInt(m[2], 10),
        y: parseInt(m[3], 10),
        w: parseInt(m[4], 10),
        h: parseInt(m[5], 10),
      })
    }

    return cues
  }

  const videoRef = useRef<HTMLVideoElement>(null)
  const hasInitiallySeenRef = useRef(false) // Track if initial seek already happened
  const lastTimeUpdateRef = useRef(0) // Throttle time updates
  const previousVideoNameRef = useRef<string | null>(null)
  const currentTimeRef = useRef(0)
  const selectedVideoIdRef = useRef<string | null>(null)
  const hasTrustedAspectRatioRef = useRef(false)
  const holdBoostPointerIdRef = useRef<number | null>(null)
  const holdBoostStartMsRef = useRef(0)
  const isHoldBoostingRef = useRef(false)
  const holdBoostTimeoutRef = useRef<number | null>(null)
  const suppressNextToggleRef = useRef(false)
  const HOLD_SPEED_BOOST_DELAY_MS = 220

  // Double-tap / double-click to seek (YouTube-style). A single tap is delayed by
  // DOUBLE_TAP_MS so a follow-up tap can be recognised as a double-tap before the
  // play/pause toggle fires (avoids a play/pause flicker on double-tap).
  const SEEK_STEP_SECONDS = 10
  const DOUBLE_TAP_MS = 280
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' } | null>(null)
  const pendingSingleTapRef = useRef<number | null>(null)
  // Accumulated seek amount for the current chain of taps on the same side, so the
  // indicator can show "20 seconds" etc. when the viewer taps repeatedly.
  const seekChainAmountRef = useRef(0)
  // Separate chain tracking for keyboard (Arrow-key) seeks so rapid presses on the
  // same side accumulate the indicator ("20 seconds", …) without touching the tap chain.
  const keySeekChainRef = useRef<{ side: 'left' | 'right'; time: number; amount: number } | null>(null)
  const seekIndicatorTimeoutRef = useRef<number | null>(null)
  const centerPulseTimeoutRef = useRef<number | null>(null)

  // If ANY video is approved, only show approved videos (for both admin and client)
  const hasAnyApprovedVideo = videos.some((v: any) => v.approved === true)
  const displayVideos = hasAnyApprovedVideo
    ? videos.filter((v: any) => v.approved === true)
    : videos

  // Safety check: ensure index is valid
  const safeIndex = Math.min(selectedVideoIndex, displayVideos.length - 1)
  const selectedVideo = displayVideos[safeIndex >= 0 ? safeIndex : 0]

  const effectiveDurationSeconds =
    durationSeconds || (selectedVideo?.duration as number | undefined) || 0

  // HLS master-playlist URL handed back by the share/guest/admin token routes. HLS is the
  // sole playback path now — when this is empty (packaging not yet ready) the player shows a
  // "preparing stream" state rather than falling back to a single-file MP4.
  const selectedVideoHlsUrl = (selectedVideo?.hlsUrl as string | undefined) || undefined
  // Whether this video's HLS renditions are keyframe-aligned and safe for hls.js auto-ABR.
  // Legacy (non-aligned) bundles stay pinned to avoid glitchy automatic switching.
  const selectedVideoHlsAbr = (selectedVideo?.hlsAbr as boolean | undefined) === true
  // Prefer hls.js (MSE) wherever it's supported — that's every desktop browser including
  // desktop Safari. iOS Safari has no MSE for video, so it falls back to native HLS.
  const hlsMode: 'mse' | 'native' | null = useMemo(() => {
    if (!selectedVideoHlsUrl) return null
    if (hlsSupport.mse) return 'mse'
    if (hlsSupport.native) return 'native'
    return null
  }, [selectedVideoHlsUrl, hlsSupport])

  // Resolve the <video> element's src (HLS only — there is no MP4 fallback):
  //  - capability probe not resolved yet → hold off
  //  - hls.js (MSE) → no src; the Hls instance feeds the element via MSE
  //  - native HLS → the master playlist URL directly
  //  - no HLS available → undefined (the "preparing stream" placeholder shows instead)
  const videoElementSrc =
    !hlsResolved
      ? undefined
      : hlsMode === 'native'
        ? selectedVideoHlsUrl
        : undefined

  // With no MP4 fallback, an empty hlsUrl drives a placeholder. That covers two cases: the
  // parent is still minting the playback token (normal, brief) OR the video genuinely has no
  // HLS bundle (failed packaging / streaming disabled). To avoid flashing a scary "not
  // available" message on every healthy video during the token fetch, wait a short grace
  // window before escalating the copy from "preparing" to "not available". The window resets
  // per video and is cancelled the moment a real hlsUrl arrives.
  const [hlsWaitElapsed, setHlsWaitElapsed] = useState(false)
  useEffect(() => {
    if (selectedVideoHlsUrl) {
      setHlsWaitElapsed(false)
      return
    }
    setHlsWaitElapsed(false)
    const timer = setTimeout(() => setHlsWaitElapsed(true), 5000)
    return () => clearTimeout(timer)
  }, [selectedVideo?.id, selectedVideoHlsUrl])

  const effectiveFps = selectedVideo?.fps as number | undefined

  const selectedVideoWidth = selectedVideo?.width as number | undefined
  const selectedVideoHeight = selectedVideo?.height as number | undefined

  const selectedVideoTimelineVttUrl = selectedVideo?.timelineVttUrl as string | null | undefined
  const selectedVideoTimelineSpriteUrl = selectedVideo?.timelineSpriteUrl as string | null | undefined
  const selectedVideoTimelinePreviewsReady = selectedVideo?.timelinePreviewsReady === true

  const desktopOffsetPx =
    typeof viewportHeightOffsetPx === 'number' && Number.isFinite(viewportHeightOffsetPx)
      ? Math.max(0, Math.round(viewportHeightOffsetPx))
      : null

  const controlsBottomPadding =
    typeof controlsBottomPaddingPx === 'number' && Number.isFinite(controlsBottomPaddingPx)
      ? Math.max(0, Math.round(controlsBottomPaddingPx))
      : 0

  const nonFitMaxHeight = isMobileViewport
    ? '70vh'
    : desktopOffsetPx
      ? `calc(100vh - var(--admin-header-height,0px) - ${desktopOffsetPx}px)`
      : '95vh'

  const nonFitMaxHeightDvh = isMobileViewport
    ? '70dvh'
    : desktopOffsetPx
      ? `calc(100dvh - var(--admin-header-height,0px) - ${desktopOffsetPx}px)`
      : '95dvh'

  const fitMaxHeightDvh = !isMobileViewport && desktopOffsetPx
    ? `calc(100dvh - var(--admin-header-height,0px) - ${desktopOffsetPx}px)`
    : undefined

  // When switching videos, the new <video> element will start paused.
  // If we were playing previously, React state can get "stuck" because the old
  // element unmounts without firing a pause event.
  useEffect(() => {
    setIsPlaying(false)
    setTimelineHover((prev) => ({ ...prev, visible: false }))
    // Keep the poster hidden when this video was opened with an autoplay request, so the
    // thumbnail never flashes before the first frame. Otherwise reset to the default
    // (poster shown until the user presses play).
    setShowPosterOverlay(autoPlayRequestRef.current !== selectedVideo?.id)
    const w = selectedVideoWidth
    const h = selectedVideoHeight
    if (
      typeof w === 'number' &&
      typeof h === 'number' &&
      Number.isFinite(w) &&
      Number.isFinite(h) &&
      w > 0 &&
      h > 0
    ) {
      hasTrustedAspectRatioRef.current = true
      setVideoAspectRatio(w / h)
    } else {
      hasTrustedAspectRatioRef.current = false
      setVideoAspectRatio(DEFAULT_ASPECT_RATIO)
    }
  }, [selectedVideo?.id, selectedVideoWidth, selectedVideoHeight])

  const timelineCommentMarkers = useMemo(() => {
    if (disableCommentsUI) {
      return [] as Array<{ id: string; seconds: number; timecodeEndSeconds: number | null; isInternal: boolean; replyCount: number; displayColor?: string | null; authorName?: string | null; authorEmail?: string | null; avatarUrl?: string | null }>
    }

    const duration = effectiveDurationSeconds
    if (!selectedVideo?.id || !duration || duration <= 0) {
      return [] as Array<{ id: string; seconds: number; timecodeEndSeconds: number | null; isInternal: boolean; replyCount: number; displayColor?: string | null; authorName?: string | null; authorEmail?: string | null; avatarUrl?: string | null }>
    }

    const fps = selectedVideo?.fps || 24

    const markers: Array<{ id: string; seconds: number; timecodeEndSeconds: number | null; isInternal: boolean; replyCount: number; displayColor?: string | null; authorName?: string | null; authorEmail?: string | null; avatarUrl?: string | null }> = []
    // Only show markers for top-level comments.
    // Replies are nested and should not create their own timeline markers.
    for (const comment of commentsForTimeline || []) {
      if (!comment) continue
      if (comment.videoId !== selectedVideo.id) continue
      if (!comment.timecode) continue
      if (!comment.id) continue
      if ((comment as any).parentId) continue
      try {
        const seconds = timecodeToSeconds(String(comment.timecode), fps)
        if (!Number.isFinite(seconds)) continue
        const clamped = Math.min(duration, Math.max(0, seconds))
        const timecodeEndSeconds = (() => {
          const rawEnd = (comment as any).timecodeEnd
          if (!rawEnd) return null
          try {
            const s = timecodeToSeconds(String(rawEnd), fps)
            return Number.isFinite(s) ? Math.min(duration, Math.max(0, s)) : null
          } catch { return null }
        })()
        markers.push({
          id: String(comment.id),
          seconds: clamped,
          timecodeEndSeconds,
          isInternal: Boolean((comment as any).isInternal),
          replyCount: Array.isArray((comment as any).replies) ? (comment as any).replies.length : 0,
          displayColor: (comment as any).displayColor || null,
          authorName: (comment as any).authorName || null,
          authorEmail: (comment as any).authorEmail || null,
          avatarUrl: (comment as any).avatarUrl || null,
        })
      } catch {
        // ignore invalid timecodes
      }
    }

    // Deduplicate by id
    const seen = new Set<string>()
    return markers.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [commentsForTimeline, disableCommentsUI, effectiveDurationSeconds, selectedVideo])

  const commentByIdForTimeline = useMemo(() => {
    const map = new Map<string, any>()
    for (const c of commentsForTimeline || []) {
      if (c?.id) map.set(String(c.id), c)
      if (Array.isArray((c as any)?.replies)) {
        for (const r of (c as any).replies as any[]) {
          if (r?.id) map.set(String(r.id), r)
        }
      }
    }
    return map
  }, [commentsForTimeline])

  const hoveredBaseCommentForTimeline = useMemo(() => {
    if (!timelineCommentHover.visible || !timelineCommentHover.commentId) return null
    const hovered = commentByIdForTimeline.get(timelineCommentHover.commentId)
    if (!hovered) return null

    const parentId = (hovered as any)?.parentId ? String((hovered as any).parentId) : null
    if (parentId) {
      return commentByIdForTimeline.get(parentId) || hovered
    }

    return hovered
  }, [commentByIdForTimeline, timelineCommentHover.commentId, timelineCommentHover.visible])

  const getTimelineCommentPreviewText = (content: unknown) => {
    return String(content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Dispatch event when selected video changes (for immediate comment section update)
  useEffect(() => {
    if (selectedVideo?.id) {
      // Reset playback time when switching versions so UI (and comment timestamp) returns to 0.
      try {
        if (videoRef.current) {
          videoRef.current.currentTime = 0
        }
      } catch {
        // ignore
      }

      currentTimeRef.current = 0
      setCurrentTimeSeconds(0)

      // Keep comment timestamp displays in sync immediately (without waiting for timeupdate).
      window.dispatchEvent(
        new CustomEvent('videoTimeUpdated', {
          detail: { time: 0, videoId: selectedVideo.id },
        })
      )

      window.dispatchEvent(new CustomEvent('videoChanged', {
        detail: { videoId: selectedVideo.id }
      }))

      // Deactivate any active comment range when switching videos
      setCommentRangeActive(false)
      commentPointFollowsPlayheadRef.current = false
      draggingRangeHandle.current = null
      setActiveRangeDragHandle(null)
    }
  }, [selectedVideo?.id])

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideo?.id ?? null
  }, [selectedVideo?.id])

  useEffect(() => {
    if (!activeVideoName) return
    if (previousVideoNameRef.current && previousVideoNameRef.current !== activeVideoName) {
      setSelectedVideoIndex(0)
      currentTimeRef.current = 0
    }
    previousVideoNameRef.current = activeVideoName
  }, [activeVideoName])

  // Comment range activation/deactivation driven by CommentInput focus
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (disableCommentsUI) return

    const emitRangeChanged = (start: number, end: number) => {
      const separation = end - start
      const hasRange = commentRangeHasExplicitSelectionRef.current && separation >= 0.5
      window.dispatchEvent(new CustomEvent('commentRangeChanged', {
        detail: { start, ...(hasRange ? { end } : {}) }
      }))
    }

    const handleActivate = () => {
      // If already active, don't reset — let the user keep their current range.
      if (commentRangeActiveRef.current) return
      const current = currentTimeRef.current
      const duration = effectiveDurationSeconds
      // Both handles start as a single point at the playhead (the ball). They are
      // drawn flanking the ball with a small fixed-pixel gap purely in the render,
      // so the visual gap is consistent regardless of duration / timeline width
      // (no misleading time-percentage gap).
      const start = duration > 0 ? Math.min(Math.max(0, current), duration) : Math.max(0, current)
      const end = start
      setCommentRangeActive(true)
      commentRangeHasExplicitSelectionRef.current = false
      // Fresh point sits on the playhead and should ride it until placed.
      commentPointFollowsPlayheadRef.current = true
      keepTimelineHoverPinnedRef.current = false
      // Start with a visible gap; still treated as a point until the user explicitly drags a handle.
      setCommentRangeStart(start)
      setCommentRangeEnd(end)
      commentRangeStartRef.current = start
      commentRangeEndRef.current = end
      // Dispatch start only; end is omitted because handles are together.
      emitRangeChanged(start, end)
    }

    const handleDeactivate = () => {
      setCommentRangeActive(false)
      commentRangeHasExplicitSelectionRef.current = false
      commentPointFollowsPlayheadRef.current = false
      keepTimelineHoverPinnedRef.current = false
      isRangeFramePreviewActiveRef.current = false
      rangeFramePreviewOriginalPlayheadRef.current = null
      draggingRangeHandle.current = null
      setActiveRangeDragHandle(null)
      // The range (and its ✕) is going away — drop any lingering hover target and
      // hide the scrub preview, otherwise the ✕'s "CLEAR TIME RANGE" cue can stay
      // stuck on screen because the ✕ unmounts before its pointer-leave fires.
      setHoverTimelineTarget(null)
      setTimelineHover((prev) => ({ ...prev, visible: false }))
    }

    const handleResetOut = () => {
      if (!commentRangeActiveRef.current) return
      const start = commentRangeStartRef.current
      // Reset OUT back onto the IN point — the brackets flank the ball visually.
      const end = start
      setCommentRangeEnd(end)
      commentRangeEndRef.current = end
      commentRangeHasExplicitSelectionRef.current = false
      emitRangeChanged(start, end)
    }

    const handleAdjustFromInput = (event: Event) => {
      const e = event as CustomEvent<{ handle?: 'start' | 'end'; deltaSeconds?: number }>
      const handle = e.detail?.handle
      const delta = typeof e.detail?.deltaSeconds === 'number' ? e.detail.deltaSeconds : 0
      if (!handle || !Number.isFinite(delta) || delta === 0) return

      // A deliberate nudge detaches the marker from the playhead.
      commentPointFollowsPlayheadRef.current = false
      const duration = effectiveDurationSeconds
      const tinyGap = 0.1
      if (!commentRangeActiveRef.current) {
        const current = currentTimeRef.current
        const baseStart = duration > tinyGap
          ? Math.min(current, duration - tinyGap)
          : Math.max(0, current)
        const baseEnd = duration > 0
          ? Math.min(duration, baseStart + tinyGap)
          : baseStart + tinyGap
        setCommentRangeActive(true)
        setCommentRangeStart(baseStart)
        setCommentRangeEnd(baseEnd)
        commentRangeStartRef.current = baseStart
        commentRangeEndRef.current = baseEnd
        commentRangeHasExplicitSelectionRef.current = false
      }

      const start = commentRangeStartRef.current
      const end = commentRangeEndRef.current

      if (handle === 'start') {
        const nextStart = Math.max(0, Math.min(start + delta, end - tinyGap))
        setCommentRangeStart(nextStart)
        commentRangeStartRef.current = nextStart
        commentRangeHasExplicitSelectionRef.current = (end - nextStart) >= 0.5
        emitRangeChanged(nextStart, end)
        return
      }

      const maxEnd = duration > 0 ? duration : end + Math.abs(delta)
      const nextEnd = Math.min(maxEnd, Math.max(end + delta, start + tinyGap))
      setCommentRangeEnd(nextEnd)
      commentRangeEndRef.current = nextEnd
      commentRangeHasExplicitSelectionRef.current = (nextEnd - start) >= 0.5
      emitRangeChanged(start, nextEnd)
    }

    // Set the in/out handles to absolute times (driven by the comment-time editor modal).
    // `start`/`end` are seconds. `end: null` collapses to a point marker on the IN time.
    const handleSetFromInput = (event: Event) => {
      const e = event as CustomEvent<{ start?: number; end?: number | null }>
      const detail = e.detail || {}
      const duration = effectiveDurationSeconds
      const clampToDuration = (v: number) => {
        const lo = Math.max(0, v)
        return duration > 0 ? Math.min(lo, duration) : lo
      }

      if (!commentRangeActiveRef.current) {
        setCommentRangeActive(true)
        keepTimelineHoverPinnedRef.current = false
      }
      // A typed time is a deliberate placement — detach from the playhead.
      commentPointFollowsPlayheadRef.current = false

      let start = commentRangeStartRef.current
      let end = commentRangeEndRef.current

      if (typeof detail.start === 'number' && Number.isFinite(detail.start)) {
        start = clampToDuration(detail.start)
      }

      if (detail.end === null) {
        // Collapse OUT back onto IN — a single point marker.
        end = start
        commentRangeHasExplicitSelectionRef.current = false
      } else if (typeof detail.end === 'number' && Number.isFinite(detail.end)) {
        end = Math.max(start, clampToDuration(detail.end))
        commentRangeHasExplicitSelectionRef.current = (end - start) >= 0.5
      } else {
        if (end < start) end = start
        commentRangeHasExplicitSelectionRef.current = (end - start) >= 0.5
      }

      setCommentRangeStart(start)
      commentRangeStartRef.current = start
      setCommentRangeEnd(end)
      commentRangeEndRef.current = end
      emitRangeChanged(start, end)
    }

    window.addEventListener('activateCommentRange', handleActivate)
    window.addEventListener('deactivateCommentRange', handleDeactivate)
    window.addEventListener('resetCommentRangeOut', handleResetOut)
    window.addEventListener('adjustCommentRangeHandle', handleAdjustFromInput)
    window.addEventListener('setCommentRange', handleSetFromInput)
    return () => {
      window.removeEventListener('activateCommentRange', handleActivate)
      window.removeEventListener('deactivateCommentRange', handleDeactivate)
      window.removeEventListener('resetCommentRangeOut', handleResetOut)
      window.removeEventListener('adjustCommentRangeHandle', handleAdjustFromInput)
      window.removeEventListener('setCommentRange', handleSetFromInput)
    }
  }, [disableCommentsUI, effectiveDurationSeconds])

  // While the point marker is still attached to the playhead, keep the IN/OUT
  // brackets flanking the ball as it moves — so the marker and the timecode shown
  // above the comment box (which also tracks the playhead) never disagree. A
  // deliberate placement (handle drag, nudge, or typed time) detaches it.
  useEffect(() => {
    if (!commentRangeActive) return
    if (!commentPointFollowsPlayheadRef.current) return
    if (
      commentRangeStartRef.current === currentTimeSeconds &&
      commentRangeEndRef.current === currentTimeSeconds
    ) {
      return
    }
    setCommentRangeStart(currentTimeSeconds)
    commentRangeStartRef.current = currentTimeSeconds
    setCommentRangeEnd(currentTimeSeconds)
    commentRangeEndRef.current = currentTimeSeconds
    // Keep the comment-box timecode locked to the marker (a point, so no `end`),
    // rather than relying on the video element's slightly-delayed timeupdate.
    window.dispatchEvent(
      new CustomEvent('commentRangeChanged', { detail: { start: currentTimeSeconds } })
    )
  }, [currentTimeSeconds, commentRangeActive])

  const isInFullscreen = isFullscreen || isPseudoFullscreen
  const prevIsInFullscreenRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const onSetOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail
      if (typeof detail?.open !== 'boolean') return
      setIsFullscreenChatOpen(detail.open)
    }

    window.addEventListener('fullscreenChatSetOpen', onSetOpen)
    return () => window.removeEventListener('fullscreenChatSetOpen', onSetOpen)
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      const container = playerContainerRef.current
      setIsFullscreen(Boolean(container && document.fullscreenElement === container))
      setIsBuffering(false)
      suppressAutoDowngradeUntilRef.current = Date.now() + 1500
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    handleFullscreenChange()
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (disableFullscreenCommentsUI) {
      setIsFullscreenChatOpen(false)
      window.dispatchEvent(
        new CustomEvent('fullscreenChatSetOpen', {
          detail: { open: false },
        })
      )
      return
    }

    window.dispatchEvent(
      new CustomEvent('videoFullscreenStateChanged', {
        detail: { isInFullscreen },
      })
    )

    // Default behavior: when entering fullscreen on desktop (pointer-fine), open the chat overlay.
    const wasInFullscreen = prevIsInFullscreenRef.current
    if (!wasInFullscreen && isInFullscreen && canShowTimelineHover) {
      window.dispatchEvent(
        new CustomEvent('fullscreenChatSetOpen', {
          detail: { open: true },
        })
      )
    }

    prevIsInFullscreenRef.current = isInFullscreen

    if (!isInFullscreen && isFullscreenChatOpen) {
      window.dispatchEvent(
        new CustomEvent('fullscreenChatSetOpen', {
          detail: { open: false },
        })
      )
    }
  }, [canShowTimelineHover, disableFullscreenCommentsUI, isInFullscreen, isFullscreenChatOpen])

  useEffect(() => {
    if (!isPseudoFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isPseudoFullscreen])

  useEffect(() => {
    if (!isPseudoFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPseudoFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isPseudoFullscreen])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const onRequestExitFullscreen = async () => {
      if (isPseudoFullscreen) {
        setIsPseudoFullscreen(false)
        return
      }

      const container = playerContainerRef.current
      if (container && document.fullscreenElement === container) {
        try {
          await document.exitFullscreen()
        } catch {
          // ignore
        }
      }
    }

    window.addEventListener('requestExitVideoFullscreen', onRequestExitFullscreen as EventListener)
    return () => window.removeEventListener('requestExitVideoFullscreen', onRequestExitFullscreen as EventListener)
  }, [isPseudoFullscreen])

  const toggleFullscreen = async () => {
    // Exit pseudo-fullscreen if active
    if (isPseudoFullscreen) {
      setIsPseudoFullscreen(false)
      return
    }

    const container = playerContainerRef.current
    if (!container) return

    // Exit browser fullscreen if already active
    if (document.fullscreenElement === container) {
      try {
        await document.exitFullscreen()
      } catch {
        // ignore
      }
      return
    }

    // Prefer Fullscreen API so custom controls remain visible.
    try {
      await container.requestFullscreen()
    } catch {
      // Fallback for platforms/browsers that don't allow element fullscreen
      setIsPseudoFullscreen(true)
    }
  }


  // Safety check: ensure selectedVideo exists before accessing properties
  const isVideoApproved = selectedVideo ? selectedVideo.approved === true : false
  const isProjectApproved = projectStatus === 'APPROVED' || projectStatus === 'SHARE_ONLY'
  const approvedDownloadUrl = selectedVideo?.downloadUrl as string | null | undefined
  const canShowApprovedDownload =
    !hideDownloadButton && !isAdmin && !isGuest && isVideoApproved && Boolean(approvedDownloadUrl)

  const approvedVideoName = String(selectedVideo?.name || 'Video')
  const approvedVideoVersionLabel = String(selectedVideo?.versionLabel || selectedVideo?.version || '')

  const handleApprovedDownloadClick = async () => {
    const video = selectedVideo
    if (!video?.id) return

    // Share view: route users back to the Files browser.
    if (!isAdmin && !isGuest) {
      window.dispatchEvent(new CustomEvent('requestExitVideoFullscreen'))

      // Combined files view: close the player and return to the Files browser.
      if (onCloseVideo) {
        onCloseVideo()
        return
      }

      const folderName = String(video?.versionLabel || video?.name || '').trim()
      if (!folderName) return

      window.dispatchEvent(
        new CustomEvent('shareOpenFilesForVideo', {
          detail: { folderName },
        })
      )
      return
    }

    if (!approvedDownloadUrl) return

    // Always show the modal so clients can clearly choose video-only vs assets.
    setShowApprovedDownloadOptions(true)
  }

  // Speed controls should be hidden only when an approved video is selected in the client view.
  // This keeps the mobile controls row from getting too cramped once Download is shown.
  const shouldHideSpeedControls = !isAdmin && !isGuest && isVideoApproved

  // Suppress the native long-press/right-click "Save/Download Video" affordances for clients
  // AND for the admin share *preview* (which passes hideDownloadButton to mirror the client).
  // Admins on their own project views keep native save.
  const suppressDownloadUi = !isAdmin || hideDownloadButton

  // Compute available qualities from the selected video's stream URLs
  // Map HLS rendition heights → quality labels, low→high. This is the real playback ladder.
  const hlsQualities = useMemo(() => {
    const set = new Set<'480p' | '720p' | '1080p'>()
    for (const h of hlsLevelHeights) set.add(h >= 1080 ? '1080p' : h >= 720 ? '720p' : '480p')
    return (['480p', '720p', '1080p'] as const).filter((q) => set.has(q))
  }, [hlsLevelHeights])

  const availableQualities = useMemo(() => {
    if (!selectedVideo) return [] as ('480p' | '720p' | '1080p')[]
    // HLS is the playback path — prefer its rendition ladder. Fall back to legacy MP4 stream
    // URLs only when there's no HLS (e.g. native HLS hasn't exposed levels, or pre-HLS video).
    if (selectedVideoHlsUrl && hlsQualities.length > 0) return [...hlsQualities]
    const q: ('480p' | '720p' | '1080p')[] = []
    if (selectedVideo.streamUrl480p) q.push('480p')
    if (selectedVideo.streamUrl720p) q.push('720p')
    if (selectedVideo.streamUrl1080p) q.push('1080p')
    return q
  }, [selectedVideo, selectedVideoHlsUrl, hlsQualities])

  // True when there are no selectable renditions but the original video stream is present —
  // the selector then shows "Original". Never the case while HLS is the active source.
  const hasOriginalOnly = useMemo(() => {
    if (!selectedVideo || selectedVideoHlsUrl) return false
    const hasPreviews = !!(
      selectedVideo.streamUrl480p ||
      selectedVideo.streamUrl720p ||
      selectedVideo.streamUrl1080p
    )
    return !hasPreviews && !!selectedVideo.streamUrlOriginal
  }, [selectedVideo, selectedVideoHlsUrl])

  const showQualitySelector = availableQualities.length > 1 || hasOriginalOnly

  const qualityMenuOptions = useMemo(
    () => [...availableQualities].slice().reverse(),
    [availableQualities]
  )

  // Determine effective quality (what we actually play)
  const effectiveQuality = useMemo(() => {
    if (selectedQuality === 'auto') return autoResolvedQuality
    // If the selected quality isn't available, fall back
    if (availableQualities.includes(selectedQuality)) return selectedQuality
    return availableQualities[availableQualities.length - 1] || '720p'
  }, [selectedQuality, autoResolvedQuality, availableQualities])

  // Quality display label for the button
  const qualityLabel = hasOriginalOnly
    ? 'Original'
    : selectedQuality === 'auto'
      ? `Auto (${autoResolvedQuality})`
      : selectedQuality

  // Auto mode: adapt quality based on player size
  useEffect(() => {
    if (selectedQuality !== 'auto') return
    const container = playerContainerRef.current
    if (!container) return

    function pickQualityForSize() {
      const el = playerContainerRef.current
      if (!el) return
      const w = el.clientWidth
      let pick: '480p' | '720p' | '1080p' = '720p'
      if (w >= 1200) pick = '1080p'
      else if (w >= 640) pick = '720p'
      else pick = '480p'
      // Only pick from available qualities
      if (availableQualities.length > 0) {
        if (availableQualities.includes(pick)) {
          setAutoResolvedQuality(pick)
        } else {
          // Pick the closest available quality
          const order: ('480p' | '720p' | '1080p')[] = ['480p', '720p', '1080p']
          const pickIdx = order.indexOf(pick)
          // Try lower, then higher
          let found = availableQualities[0]
          for (let i = pickIdx; i >= 0; i--) {
            if (availableQualities.includes(order[i])) { found = order[i]; break }
          }
          if (!availableQualities.includes(found)) {
            for (let i = pickIdx; i < order.length; i++) {
              if (availableQualities.includes(order[i])) { found = order[i]; break }
            }
          }
          setAutoResolvedQuality(found)
        }
      }
    }

    pickQualityForSize()

    const observer = new ResizeObserver(() => pickQualityForSize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [selectedQuality, availableQualities])

  // Auto mode: downgrade on buffering
  useEffect(() => {
    if (selectedQuality !== 'auto' || !isBuffering) return
    if (Date.now() < suppressAutoDowngradeUntilRef.current) return
    const order: ('480p' | '720p' | '1080p')[] = ['480p', '720p', '1080p']
    const currentIdx = order.indexOf(autoResolvedQuality)
    if (currentIdx > 0) {
      // Try to downgrade to a lower available quality
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (availableQualities.includes(order[i])) {
          setAutoResolvedQuality(order[i])
          break
        }
      }
    }
  }, [selectedQuality, isBuffering, autoResolvedQuality, availableQualities])

  // Buffering detection
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const clearBufferingTimeout = () => {
      if (bufferingTimeoutRef.current !== null) {
        window.clearTimeout(bufferingTimeoutRef.current)
        bufferingTimeoutRef.current = null
      }
    }
    const clearBufferingState = () => {
      clearBufferingTimeout()
      setIsBuffering(false)
    }
    const onWaiting = () => {
      if (video.paused || video.ended || video.seeking) return
      if (Date.now() < suppressAutoDowngradeUntilRef.current) return
      clearBufferingTimeout()
      bufferingTimeoutRef.current = window.setTimeout(() => {
        if (!video.paused && !video.ended && !video.seeking) {
          setIsBuffering(true)
        }
      }, 700)
    }
    const onPlaying = () => clearBufferingState()
    const onCanPlay = () => clearBufferingState()
    const onSeeked = () => {
      clearBufferingState()
      // First real frame after engaging precision has landed — safe to reveal the
      // <video> and drop the bridging sprite overlay without a stale-frame flash.
      if (precisionDragAnchorRef.current) setPrecisionFrameReady(true)
      // Same idea for a normal (no-Shift) scrub release: the released frame has
      // landed, so end the bridge and drop the sprite overlay.
      if (scrubSettlingRef.current) finishScrubSettleRef.current()
    }
    const onTimeUpdate = () => clearBufferingState()
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      clearBufferingTimeout()
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [selectedVideo?.id]) // re-attach when the video (and thus the element) changes

  // Close quality menu on click outside
  useEffect(() => {
    if (!showQualityMenu) return
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      const insideDesktop = Boolean(desktopQualityControlsRef.current?.contains(target))
      const insideMobile = Boolean(mobileQualityControlsRef.current?.contains(target))
      if (!insideDesktop && !insideMobile) {
        setShowQualityMenu(false)
      }
    }
    document.addEventListener('pointerdown', handleClickOutside)
    return () => document.removeEventListener('pointerdown', handleClickOutside)
  }, [showQualityMenu])

  // Ask the parent to re-mint tokens after an unrecoverable stream failure. Latches per
  // videoId (cleared on the next successful loadedmetadata) so an error→refresh→error
  // sequence can't loop. Shared by the MP4 <video> onError and the hls.js error handler.
  const triggerStreamErrorRecovery = useCallback(() => {
    const vid = selectedVideoIdRef.current
    if (!vid) return
    if (streamErrorRecoveryRef.current === vid) return
    streamErrorRecoveryRef.current = vid
    onStreamError?.(vid)
  }, [onStreamError])

  // hls.js (MSE) lifecycle: attach to the <video> element and load the master playlist.
  // Re-runs when the video changes or the parent hands back a fresh hlsUrl (token refresh),
  // which is exactly how we recover from expired presigned segment URLs.
  useEffect(() => {
    if (hlsMode !== 'mse' || !selectedVideoHlsUrl) return
    const video = videoRef.current
    if (!video) return

    setHlsLevelsReady(false)
    const hls = new Hls({
      enableWorker: true,
      // Cap auto/ABR level to what the player can actually show (DPR-aware), so "Auto" never
      // streams 1080p into a small window — it still drops further on a slow connection. This
      // restores the old size-based behaviour and combines it with bandwidth adaptation; a
      // manual quality pick (fixed currentLevel) bypasses this cap.
      capLevelToPlayerSize: true,
      // Keep a tight forward buffer instead of prefetching the whole file. hls.js defaults
      // grow the buffer up to maxBufferSize (~60 MB), so any clip smaller than that downloads
      // entirely on open — wasteful for a review tool where reviewers frequently open a video,
      // glance, and jump around by timecode. Cap the forward buffer to ~30 s (and stop it
      // growing) so segments are fetched as playback approaches them; seeking still fetches the
      // target segment on demand (the proxy-robust behaviour we want). A generous back-buffer
      // keeps recently-watched segments so backward jumps don't re-download.
      maxBufferLength: 30,        // target ~30 s ahead of the playhead
      maxMaxBufferLength: 30,     // don't let the target grow — this is what stops full prefetch
      maxBufferSize: 30 * 1000 * 1000, // 30 MB secondary cap (binds for high-bitrate originals)
      backBufferLength: 60,       // retain ~60 s behind so small rewinds don't refetch
    })
    hlsInstanceRef.current = hls

    hls.attachMedia(video)
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(selectedVideoHlsUrl))
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setHlsLevelsReady(true)
      // Capture the rendition heights so the quality menu reflects the actual HLS ladder.
      setHlsLevelHeights((hls.levels || []).map((l) => l.height || 0).filter((h) => h > 0))
    })
    // Keep the "Auto (xxx)" label in sync with the level hls.js actually plays (esp. under ABR).
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const height = hls.levels?.[data.level]?.height
      if (height) setAutoResolvedQuality(height >= 1080 ? '1080p' : height >= 720 ? '720p' : '480p')
    })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); return } catch { /* fall through to re-mint */ }
      }
      // NETWORK_ERROR is most often expired presigned segment URLs — a re-mint yields a
      // fresh playlist (new signatures) and re-runs this effect. Other fatal errors also
      // escalate to the parent's token-refresh recovery.
      triggerStreamErrorRecovery()
    })

    return () => {
      setHlsLevelsReady(false)
      setHlsLevelHeights([])
      try { hls.destroy() } catch { /* ignore */ }
      if (hlsInstanceRef.current === hls) hlsInstanceRef.current = null
    }
  }, [hlsMode, selectedVideoHlsUrl, selectedVideo?.id, triggerStreamErrorRecovery])

  // Drive hls.js level selection from the quality control. For ABR-ready (keyframe-aligned)
  // bundles, "Auto" hands control to hls.js bandwidth adaptation (currentLevel = -1). A manual
  // pick — or any legacy non-aligned bundle, where automatic switching would glitch — pins the
  // nearest level instead (manual switches tolerate the brief flush).
  useEffect(() => {
    const hls = hlsInstanceRef.current
    if (hlsMode !== 'mse' || !hls || !hlsLevelsReady) return
    const levels = hls.levels || []
    if (levels.length === 0) return

    if (selectedQuality === 'auto' && selectedVideoHlsAbr) {
      if (!hls.autoLevelEnabled) hls.currentLevel = -1
      return
    }

    const targetHeight = effectiveQuality === '1080p' ? 1080 : effectiveQuality === '480p' ? 480 : 720
    let bestIdx = 0
    let bestDelta = Infinity
    levels.forEach((lvl, i) => {
      const delta = Math.abs((lvl.height || 0) - targetHeight)
      if (delta < bestDelta) { bestDelta = delta; bestIdx = i }
    })
    if (hls.currentLevel !== bestIdx) hls.currentLevel = bestIdx
  }, [hlsMode, hlsLevelsReady, effectiveQuality, selectedQuality, selectedVideoHlsAbr])

  // Load timeline preview VTT when available
  useEffect(() => {
    let cancelled = false

    async function loadTimelineVtt() {
      setTimelineCues([])
      if (!selectedVideoTimelineVttUrl || !selectedVideoTimelineSpriteUrl || !selectedVideoTimelinePreviewsReady) {
        return
      }

      try {
        const res = await fetch(selectedVideoTimelineVttUrl)
        if (!res.ok) return
        const text = await res.text()
        const cues = parseVtt(text)
        if (!cancelled) {
          setTimelineCues(cues)
        }
      } catch {
        // ignore
      }
    }

    loadTimelineVtt()
    return () => {
      cancelled = true
    }
  }, [
    selectedVideo?.id,
    selectedVideoTimelineVttUrl,
    selectedVideoTimelineSpriteUrl,
    selectedVideoTimelinePreviewsReady,
  ])

  // Preload all distinct sprite sheets once cues are known so scrubbing across
  // sprite-file boundaries doesn't flash a black frame while the next sheet
  // downloads. URLs must match exactly what the hover handlers use so the
  // browser cache entry is shared.
  useEffect(() => {
    const spriteBaseUrl = selectedVideoTimelineSpriteUrl
    if (!spriteBaseUrl || timelineCues.length === 0) return

    const seen = new Set<string>()
    const images: HTMLImageElement[] = []
    for (const cue of timelineCues) {
      if (seen.has(cue.sprite)) continue
      seen.add(cue.sprite)
      // Use createElement, not `new Image()` — `Image` is shadowed by the
      // `next/image` import at the top of this file.
      const img = document.createElement('img')
      img.src = `${spriteBaseUrl}?file=${encodeURIComponent(cue.sprite)}`
      images.push(img)
    }
    return () => {
      // Drop references so the browser can reclaim them; cache stays warm.
      images.length = 0
    }
  }, [timelineCues, selectedVideoTimelineSpriteUrl])

  // Fraction of raw cursor movement applied while precision (Shift) dragging on a
  // video with no FPS metadata (can't snap to frames). 0.15 turns a move that would
  // jump ~3s on a 30-min video into ~0.45s.
  const PRECISION_DRAG_FACTOR = 0.15
  // Frame-by-frame precision: pixels of cursor travel that advance the playhead by one
  // frame. Independent of video length, so a 30-min clip steps frames just as finely as
  // a short one. Higher = slower/finer.
  const PIXELS_PER_FRAME = 6

  // Engage/disengage precision dragging based on the live Shift state. Called from
  // every active timeline-drag move handler. Engaging captures an anchor at the
  // current cursor so the marker stays put at the moment Shift is pressed.
  const syncPrecisionAnchor = (clientX: number, shiftKey: boolean) => {
    if (!shiftKey) {
      if (precisionDragAnchorRef.current) {
        precisionDragAnchorRef.current = null
        setIsPrecisionDragging(false)
        setPrecisionFrameReady(false)
      }
      return
    }
    if (precisionDragAnchorRef.current) return
    const el = scrubBarRef.current
    const duration = (videoRef.current?.duration || durationSeconds || selectedVideo?.duration || 0) as number
    if (!el || !duration || duration <= 0) return
    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    const time = rect.width > 0 ? (x / rect.width) * duration : 0
    precisionDragAnchorRef.current = { clientX, time }
    precisionUsedThisGestureRef.current = true
    setIsPrecisionDragging(true)
    // Engaging: hold the sprite overlay until the real video seeks to the target
    // frame (see the `seeked` listener), so we don't flash its stale last frame.
    setPrecisionFrameReady(false)
  }

  const clearPrecisionAnchor = () => {
    if (precisionDragAnchorRef.current) {
      precisionDragAnchorRef.current = null
      setIsPrecisionDragging(false)
      setPrecisionFrameReady(false)
    }
  }

  // End the post-release bridge: drop the sprite overlay (the <video> now shows the
  // released frame) and clear the safety timeout. On touch, also retire the preview
  // tooltip that the desktop path leaves up while hovering.
  const finishScrubSettle = () => {
    scrubSettlingRef.current = false
    setScrubSettling(false)
    if (scrubSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrubSettleTimeoutRef.current)
      scrubSettleTimeoutRef.current = null
    }
    if (!canShowTimelineHover) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
    }
  }
  finishScrubSettleRef.current = finishScrubSettle

  // Start the post-release bridge after a normal (non-precision) scrub release. If the
  // video has already reached the released frame there's nothing to bridge, so finish
  // immediately; otherwise hold the sprite overlay until `seeked` (or the timeout).
  const beginScrubSettle = () => {
    const video = videoRef.current
    if (!video || !video.seeking) {
      finishScrubSettle()
      return
    }
    scrubSettlingRef.current = true
    setScrubSettling(true)
    if (scrubSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrubSettleTimeoutRef.current)
    }
    scrubSettleTimeoutRef.current = window.setTimeout(() => {
      finishScrubSettleRef.current()
    }, 600)
  }

  const getTimeFromScrubEvent = (clientX: number) => {
    const el = scrubBarRef.current
    const duration = (videoRef.current?.duration || durationSeconds || selectedVideo?.duration || 0) as number
    if (!el || !duration || duration <= 0) return { time: 0, left: 0, width: 0 }
    const rect = el.getBoundingClientRect()
    // Precision drag: map movement relative to the anchor, scaled down, so the
    // marker tracks a fraction of the cursor's travel. left is derived from the
    // resulting time so the preview/playhead stay visually aligned with the marker.
    const anchor = precisionDragAnchorRef.current
    if (anchor && rect.width > 0) {
      const deltaPx = clientX - anchor.clientX
      const fps = (selectedVideo?.fps as number | undefined) || 0
      if (fps > 0) {
        // Frame-by-frame: map cursor travel to whole-frame steps and snap the result
        // onto the exact frame grid, so the playhead/marker lands on real frames.
        const rawTime = anchor.time + (deltaPx / PIXELS_PER_FRAME) / fps
        const frame = Math.round(rawTime * fps)
        const time = Math.min(duration, Math.max(0, frame / fps))
        return { time, left: (time / duration) * rect.width, width: rect.width }
      }
      // No FPS metadata — can't snap to frames; fall back to scaled-time fine control.
      const time = Math.min(duration, Math.max(0, anchor.time + (deltaPx / rect.width) * duration * PRECISION_DRAG_FACTOR))
      return { time, left: (time / duration) * rect.width, width: rect.width }
    }
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    const ratio = rect.width > 0 ? x / rect.width : 0
    return { time: ratio * duration, left: x, width: rect.width }
  }

  const getLeftPxForSeconds = (seconds: number, maxTooltipWidthPx: number) => {
    const el = scrubBarRef.current
    const duration = effectiveDurationSeconds
    if (!el || !duration || duration <= 0) return 0
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, seconds / duration))
    const desiredLeft = ratio * rect.width
    const half = Math.max(0, maxTooltipWidthPx / 2)

    if (rect.width <= 0) return 0
    if (rect.width < maxTooltipWidthPx) return rect.width / 2
    return Math.min(Math.max(desiredLeft, half), Math.max(half, rect.width - half))
  }

  const findCueForTime = (timeSeconds: number) => {
    // Linear scan is fine for typical cue counts (<= a few thousand)
    for (const cue of timelineCues) {
      if (timeSeconds >= cue.start && timeSeconds < cue.end) return cue
    }
    return null
  }

  const updateHoverFromTimeSeconds = (timeSeconds: number, minClampWidthPx?: number, forcePreview = false) => {
    if (!canShowTimelineHover && !forcePreview) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return null as number | null
    }

    const spriteBaseUrl = selectedVideo?.timelineSpriteUrl as string | null | undefined
    const duration = (videoRef.current?.duration || durationSeconds || selectedVideo?.duration || 0) as number
    const el = scrubBarRef.current

    if (!el || !duration || duration <= 0 || !spriteBaseUrl || timelineCues.length === 0) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return null as number | null
    }

    const rect = el.getBoundingClientRect()
    const time = Math.min(duration, Math.max(0, timeSeconds))
    const cue = findCueForTime(time)
    if (!cue) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return null as number | null
    }

    const desiredLeft = rect.width > 0 ? (time / duration) * rect.width : 0
    const clampWidth = Math.max(cue.w, minClampWidthPx || 0)
    const half = clampWidth / 2
    const clampedLeft = Math.min(
      Math.max(desiredLeft, half),
      Math.max(half, rect.width - half)
    )

    const spriteUrl = `${spriteBaseUrl}?file=${encodeURIComponent(cue.sprite)}`
    setTimelineHover({
      visible: true,
      leftPx: clampedLeft,
      timeSeconds: time,
      spriteUrl,
      x: cue.x,
      y: cue.y,
      w: cue.w,
      h: cue.h,
    })

    return clampedLeft
  }

  const updateHoverFromClientX = (clientX: number, forcePreview = false) => {
    if (!canShowTimelineHover && !forcePreview) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return
    }

    const spriteBaseUrl = selectedVideo?.timelineSpriteUrl as string | null | undefined
    if (!spriteBaseUrl || timelineCues.length === 0) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return
    }

    const { time, left, width } = getTimeFromScrubEvent(clientX)
    const cue = findCueForTime(time)
    if (!cue) {
      setTimelineHover((prev) => ({ ...prev, visible: false }))
      return
    }

    const desiredLeft = left
    const previewWidth = cue.w
    const clampedLeft = Math.min(Math.max(desiredLeft, previewWidth / 2), Math.max(previewWidth / 2, width - previewWidth / 2))
    const spriteUrl = `${spriteBaseUrl}?file=${encodeURIComponent(cue.sprite)}`

    setTimelineHover({
      visible: true,
      leftPx: clampedLeft,
      timeSeconds: time,
      spriteUrl,
      x: cue.x,
      y: cue.y,
      w: cue.w,
      h: cue.h,
    })
  }

  const beginRangeFramePreview = () => {
    if (!isRangeFramePreviewActiveRef.current) {
      isRangeFramePreviewActiveRef.current = true
      rangeFramePreviewOriginalPlayheadRef.current = currentTimeRef.current
    }
  }

  const previewVideoFrameAt = (timeSeconds: number) => {
    const video = videoRef.current
    if (!video) return
    try {
      setShowPosterOverlay(false)
      video.currentTime = timeSeconds
    } catch {
      // ignore seek failures during drag preview
    }
  }

  const restorePlayheadAfterRangePreview = () => {
    const resumeTime = rangeFramePreviewOriginalPlayheadRef.current
    if (!isRangeFramePreviewActiveRef.current || resumeTime === null) return

    const video = videoRef.current
    if (video) {
      try {
        video.currentTime = resumeTime
      } catch {
        // ignore
      }
    }

    currentTimeRef.current = resumeTime
    setCurrentTimeSeconds(resumeTime)
    window.dispatchEvent(
      new CustomEvent('videoTimeUpdated', {
        detail: { time: resumeTime, videoId: selectedVideoIdRef.current },
      })
    )

    isRangeFramePreviewActiveRef.current = false
    rangeFramePreviewOriginalPlayheadRef.current = null
  }

  // Subtle "stickiness" while dragging a comment IN/OUT handle: snap its time to
  // the playhead when the cursor is within a few pixels of it. Small enough that
  // you can still place a handle just before/after the playhead, but enough to
  // feel a catch right at it. We snap to `currentTimeRef` — the exact value the
  // on-screen playhead/timecode uses (and which is frozen during a handle drag,
  // since handleTimeUpdate is suppressed). Snapping to that guarantees the
  // handle's timecode matches the playhead's to the frame, with no drift.
  const SNAP_TO_PLAYHEAD_PX = 6
  // Width (px) of each comment IN/OUT marker rectangle. Its inner edge sits at
  // its point's time and the body extends this far outward from it. The playhead
  // ball renders on top (higher z), centered on the same point.
  const RANGE_HANDLE_WIDTH_PX = 12
  // Marker height (px). A touch taller than the 16px scrub bar so the markers
  // read as grabbable handles standing slightly proud of the bar.
  const RANGE_HANDLE_HEIGHT_PX = 20
  // Inset the scrub bar from its container by this much on each side so the
  // elements that overhang a point — the playhead ball and the "[" / "]"
  // brackets — render fully at 0:00 and the end instead of being clipped. The
  // bracket reaches furthest: its full width outward from the point.
  const TIMELINE_EDGE_INSET_PX = RANGE_HANDLE_WIDTH_PX
  const snapHandleTimeToPlayhead = (candidateSeconds: number, barWidthPx: number) => {
    // Precision (Shift) dragging is for landing on an exact frame — snapping to the
    // playhead would fight that, so it's disabled while Shift is held.
    if (precisionDragAnchorRef.current) return candidateSeconds
    const playhead = currentTimeRef.current
    if (!Number.isFinite(playhead) || barWidthPx <= 0 || effectiveDurationSeconds <= 0) return candidateSeconds
    const snapSeconds = (SNAP_TO_PLAYHEAD_PX / barWidthPx) * effectiveDurationSeconds
    return Math.abs(candidateSeconds - playhead) <= snapSeconds ? playhead : candidateSeconds
  }

  // Mirror of the above for dragging the playhead itself: when a comment range is
  // active, the playhead gently snaps to the nearest visible IN/OUT handle within
  // the same ~6px threshold, so it's easy to line the playhead up with a marker.
  const snapPlayheadToHandles = (candidateSeconds: number, barWidthPx: number) => {
    // Disabled during a precision (Shift) drag — see snapHandleTimeToPlayhead.
    if (precisionDragAnchorRef.current) return candidateSeconds
    if (!commentRangeActiveRef.current || barWidthPx <= 0 || effectiveDurationSeconds <= 0) return candidateSeconds
    const snapSeconds = (SNAP_TO_PLAYHEAD_PX / barWidthPx) * effectiveDurationSeconds
    const start = commentRangeStartRef.current
    const end = commentRangeEndRef.current
    // When the handles are hard up against each other, collapse to a single snap
    // target at their exact midpoint — otherwise the playhead could catch on the
    // start or the end separately, a sliver apart.
    const targets = Math.abs(end - start) <= snapSeconds ? [(start + end) / 2] : [start, end]
    let best = candidateSeconds
    let bestDist = snapSeconds
    for (const target of targets) {
      const dist = Math.abs(candidateSeconds - target)
      if (dist <= bestDist) {
        best = target
        bestDist = dist
      }
    }
    return best
  }

  // Start playback for an autoplay request. The folder click is a user gesture, so an
  // unmuted play() normally succeeds; if the browser still blocks it (e.g. transient
  // activation expired while the source loaded), fall back to a muted autoplay so the
  // video reliably starts. The user can re-enable sound with the existing volume control.
  const startAutoPlay = async (video: HTMLVideoElement) => {
    setShowPosterOverlay(false)
    try {
      await video.play()
    } catch {
      try {
        video.muted = true
        setIsMuted(true)
        await video.play()
      } catch {
        // Give up silently; the element is left paused with controls available.
      }
    }
  }

  // Handle initial seek from URL parameters (only once on mount)
  useEffect(() => {
    if (initialSeekTime !== null && videoRef.current && selectedVideoHlsUrl && !hasInitiallySeenRef.current) {
      const videoEl = videoRef.current
      const handleLoadedMetadata = () => {
        if (initialSeekTime !== null) {
          // Ensure timestamp is within video duration
          const duration = videoEl.duration
          const seekTime = Math.min(initialSeekTime, duration)

          videoEl.currentTime = seekTime
          currentTimeRef.current = seekTime
          // Don't auto-play - mobile browsers block this anyway, let user control playback

          // Mark that we've done the initial seek
          hasInitiallySeenRef.current = true
        }
      }

      // If metadata already loaded, seek immediately
      if (videoEl.readyState >= 1) {
        handleLoadedMetadata()
      } else {
        // Otherwise wait for metadata to load
        videoEl.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
      }

      return () => {
        videoEl.removeEventListener('loadedmetadata', handleLoadedMetadata)
      }
    }
  }, [initialSeekTime, selectedVideoHlsUrl])


  // Expose current time for CommentSection
  useEffect(() => {
    const handleGetCurrentTime = (e: CustomEvent) => {
      if (e.detail.callback) {
        e.detail.callback(currentTimeRef.current, selectedVideoIdRef.current)
      }
    }

    window.addEventListener('getCurrentTime' as any, handleGetCurrentTime as EventListener)
    return () => {
      window.removeEventListener('getCurrentTime' as any, handleGetCurrentTime as EventListener)
    }
  }, [])

  // Expose duration/fps/current-time for the comment time editor (validation + format).
  useEffect(() => {
    const handleGetContext = (e: CustomEvent) => {
      if (e.detail?.callback) {
        e.detail.callback({
          duration: effectiveDurationSeconds,
          fps: effectiveFps,
          currentTime: currentTimeRef.current,
          videoId: selectedVideoIdRef.current,
        })
      }
    }

    window.addEventListener('getCommentTimeContext' as any, handleGetContext as EventListener)
    return () => {
      window.removeEventListener('getCommentTimeContext' as any, handleGetContext as EventListener)
    }
  }, [effectiveDurationSeconds, effectiveFps])

  // Expose selected video ID for approval
  useEffect(() => {
    const handleGetSelectedVideoId = (e: CustomEvent) => {
      if (e.detail.callback) {
        e.detail.callback(selectedVideoIdRef.current)
      }
    }

    window.addEventListener('getSelectedVideoId' as any, handleGetSelectedVideoId as EventListener)
    return () => {
      window.removeEventListener('getSelectedVideoId' as any, handleGetSelectedVideoId as EventListener)
    }
  }, [])

  // Handle seek to timestamp requests from comments
  useEffect(() => {
    const handleSeekToTime = (e: CustomEvent) => {
      const { timestamp, videoId, videoVersion, autoPlay } = e.detail

      // Autoplay only applies in the responsive/mobile layout (below the lg breakpoint).
      // On desktop we keep the previous behaviour: switch to the video and show its poster
      // until the user presses play.
      const effectiveAutoPlay = Boolean(autoPlay) && !isLgViewport

      // If the user is seeking to a timestamp, show actual video frames (not the poster overlay).
      setShowPosterOverlay(false)

      // If videoId is specified and different from current, try to switch to it
      if (videoId && videoId !== selectedVideo.id) {
        const targetVideoIndex = displayVideos.findIndex(v => v.id === videoId)
        if (targetVideoIndex !== -1) {
          if (effectiveAutoPlay) {
            // Record the intent so the newly-mounted <video> element starts playback
            // from its onCanPlay handler, rather than racing a fixed timeout. This also
            // keeps the poster suppressed for the whole switch (see the selection effect).
            autoPlayRequestRef.current = videoId
            autoPlaySeekRef.current = timestamp
          }
          setSelectedVideoIndex(targetVideoIndex)
          if (!effectiveAutoPlay) {
            // Wait for video to load before seeking
            setTimeout(() => {
              if (videoRef.current) {
                videoRef.current.currentTime = timestamp
                currentTimeRef.current = timestamp
              }
            }, 500)
          }
          return
        }
      }

      // Same video - just seek
      if (videoRef.current) {
        videoRef.current.currentTime = timestamp
        currentTimeRef.current = timestamp
        if (effectiveAutoPlay) {
          setShowPosterOverlay(false)
          void startAutoPlay(videoRef.current)
        }
      }
    }

    window.addEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    return () => {
      window.removeEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    }
  }, [selectedVideo.id, displayVideos, isLgViewport])

  // Pause video when user starts typing a comment
  useEffect(() => {
    const handlePauseForComment = () => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause()
      }
    }

    window.addEventListener('pauseVideoForComment', handlePauseForComment)
    return () => {
      window.removeEventListener('pauseVideoForComment', handlePauseForComment)
    }
  }, [])

  // Apply playback speed to video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed
    }
  }, [playbackSpeed])

  // Apply volume/mute to video element
  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.muted = isMuted
    // Only apply volume when not muted; browsers still keep volume value while muted
    videoRef.current.volume = Math.min(1, Math.max(0, volume))
  }, [isMuted, volume])

  // Keep local volume state in sync if user changes it externally (e.g. OS media keys)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onVolumeChange = () => {
      setIsMuted(video.muted)
      setVolume(video.volume)
    }

    video.addEventListener('volumechange', onVolumeChange)
    return () => {
      video.removeEventListener('volumechange', onVolumeChange)
    }
  }, [selectedVideo?.id])

  useEffect(() => {
    const handleOpenShortcutsDialog = () => {
      setShowShortcutsDialog(true)
    }

    window.addEventListener('openShortcutsDialog', handleOpenShortcutsDialog as EventListener)
    return () => {
      window.removeEventListener('openShortcutsDialog', handleOpenShortcutsDialog as EventListener)
    }
  }, [])

  const stepVideoFrame = useCallback((direction: -1 | 1) => {
    const video = videoRef.current
    const fps = selectedVideo?.fps
    if (!video || !fps) return

    if (!video.paused) {
      video.pause()
    }

    const frameDuration = 1 / fps
    const duration = Number.isFinite(video.duration) ? video.duration : undefined
    const nextTime = direction < 0
      ? Math.max(0, video.currentTime - frameDuration)
      : (duration ? Math.min(duration, video.currentTime + frameDuration) : video.currentTime + frameDuration)

    video.currentTime = nextTime
    currentTimeRef.current = nextTime
    setCurrentTimeSeconds(nextTime)
    window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
      detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current },
    }))
  }, [selectedVideo?.fps])

  const handleStepFrameBackward = useCallback(() => {
    stepVideoFrame(-1)
  }, [stepVideoFrame])

  const handleStepFrameForward = useCallback(() => {
    stepVideoFrame(1)
  }, [stepVideoFrame])

  // Keyboard shortcuts: Ctrl+Space (play/pause), Ctrl+,/. (speed), Ctrl+/ (reset speed), Ctrl+J/L (frame step)
  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      if (!videoRef.current) return

      const video = videoRef.current

      // Ctrl+Space: Play/Pause
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        if (video.paused) {
          restorePlayheadAfterRangePreview()
          video.play()
        } else {
          video.pause()
        }
        return
      }

      // Space (no modifiers): Play/Pause — but never steal it from a text field
      // (the comment box) or an interactive control where Space is the activation key.
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const target = (e.target as HTMLElement | null) || (document.activeElement as HTMLElement | null)
        const tag = target?.tagName
        const role = target?.getAttribute?.('role')
        const isTypingOrControl =
          !!target &&
          (tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            tag === 'BUTTON' ||
            tag === 'A' ||
            target.isContentEditable ||
            role === 'button' ||
            role === 'textbox' ||
            role === 'menuitem' ||
            role === 'option' ||
            // Anything inside an open dialog/popover (the comment-time editor, modals).
            !!target.closest?.('[role="dialog"],[aria-modal="true"]'))
        if (isTypingOrControl) return

        e.preventDefault()
        e.stopPropagation()
        if (video.paused) {
          restorePlayheadAfterRangePreview()
          video.play()
        } else {
          video.pause()
        }
        return
      }

      // ArrowLeft / ArrowRight (no modifiers): seek -/+ 10s (YouTube-style), mirroring the
      // double-click-to-seek gesture. Skipped when typing in the comment box or focused on
      // an interactive control — those need the arrows for the cursor / their own behaviour.
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const target = (e.target as HTMLElement | null) || (document.activeElement as HTMLElement | null)
        const tag = target?.tagName
        const role = target?.getAttribute?.('role')
        const isTypingOrControl =
          !!target &&
          (tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            tag === 'BUTTON' ||
            tag === 'A' ||
            target.isContentEditable ||
            role === 'button' ||
            role === 'textbox' ||
            role === 'menuitem' ||
            role === 'option' ||
            role === 'slider' ||
            !!target.closest?.('[role="dialog"],[aria-modal="true"]'))
        if (isTypingOrControl) return

        e.preventDefault()
        e.stopPropagation()

        const side: 'left' | 'right' = e.code === 'ArrowLeft' ? 'left' : 'right'
        const delta = side === 'left' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
        const upperBound = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER
        const targetTime = Math.min(upperBound, Math.max(0, (video.currentTime || 0) + delta))
        try {
          video.currentTime = targetTime
        } catch {
          // ignore seek failures
        }
        currentTimeRef.current = targetTime
        setCurrentTimeSeconds(targetTime)

        // Accumulate the on-screen indicator amount for rapid presses on the same side.
        const now = Date.now()
        const last = keySeekChainRef.current
        const amount = last && last.side === side && now - last.time < 1000 ? last.amount + SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
        keySeekChainRef.current = { side, time: now, amount }
        triggerSeekIndicator(side, amount)
        return
      }

      // Ctrl+, or Ctrl+<: Decrease speed by 0.25x
      if (e.ctrlKey && (e.code === 'Comma' || e.key === '<')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => Math.max(0.25, prev - 0.25))
        return
      }

      // Ctrl+. or Ctrl+>: Increase speed by 0.25x
      if (e.ctrlKey && (e.code === 'Period' || e.key === '>')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => Math.min(2.0, prev + 0.25))
        return
      }

      // Ctrl+/: Reset speed to 1.0x
      if (e.ctrlKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(1.0)
        return
      }

      // Ctrl+J: Go back one frame
      if (e.ctrlKey && e.code === 'KeyJ') {
        e.preventDefault()
        e.stopPropagation()
        handleStepFrameBackward()
        return
      }

      // Ctrl+L: Go forward one frame
      if (e.ctrlKey && e.code === 'KeyL') {
        e.preventDefault()
        e.stopPropagation()
        handleStepFrameForward()
        return
      }
    }

    // Use capture phase to intercept events before they reach other elements
    window.addEventListener('keydown', handleKeyboard, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyboard, { capture: true })
    }
  }, [selectedVideo, handleStepFrameBackward, handleStepFrameForward])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const now = Date.now()
      // Throttle to update max every 200ms instead of 60 times per second
      if (now - lastTimeUpdateRef.current > 200) {
        // While actively scrubbing the playhead, the scrub handler owns the
        // playhead position (a default/non-precision drag doesn't seek the video,
        // so a still-playing video's timeupdate would otherwise fight it). Same
        // reasoning as the range-frame-preview guard below.
        if (isRangeFramePreviewActiveRef.current || isScrubbingRef.current) {
          lastTimeUpdateRef.current = now
          return
        }
        currentTimeRef.current = videoRef.current.currentTime
        setCurrentTimeSeconds(videoRef.current.currentTime)
        if (Number.isFinite(videoRef.current.duration)) {
          setDurationSeconds(videoRef.current.duration)
        }

        // Keep comment time displays in sync with playback.
        window.dispatchEvent(
          new CustomEvent('videoTimeUpdated', {
            detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current },
          })
        )
        lastTimeUpdateRef.current = now
      }
    }
  }

  const togglePlayPause = async () => {
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false
      return
    }

    const video = videoRef.current
    if (!video) return
    try {
      if (video.paused) {
        restorePlayheadAfterRangePreview()
        setShowPosterOverlay(false)
        await video.play()
      } else {
        video.pause()
      }
    } catch {
      // ignore
    }
  }

  // Briefly flash the seek indicator on the tapped half of the player.
  const triggerSeekIndicator = (side: 'left' | 'right', amount: number) => {
    setSeekIndicator({ side, amount, key: Date.now() })
    if (seekIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(seekIndicatorTimeoutRef.current)
    }
    seekIndicatorTimeoutRef.current = window.setTimeout(() => {
      setSeekIndicator(null)
      seekIndicatorTimeoutRef.current = null
    }, 1200)
  }

  // Briefly flash the centred play/pause icon (mirrors the YouTube single-tap cue).
  const flashPlayPauseIcon = (kind: 'play' | 'pause') => {
    setCenterPulse({ kind, key: Date.now() })
    if (centerPulseTimeoutRef.current !== null) {
      window.clearTimeout(centerPulseTimeoutRef.current)
    }
    centerPulseTimeoutRef.current = window.setTimeout(() => {
      setCenterPulse(null)
      centerPulseTimeoutRef.current = null
    }, 1000)
  }

  // Tap/click on the video surface. A single tap (after a short delay to rule out a
  // double-tap) toggles play/pause; a double-tap on the left/right half seeks ∓10s,
  // with repeated taps on the same side chaining (+10s each), YouTube-style.
  const handleVideoClick = (e: React.MouseEvent<HTMLVideoElement>) => {
    // A hold-to-2x release ends in a click — swallow it and don't count it as a tap.
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false
      return
    }

    const video = videoRef.current
    if (!video) return

    const rect = e.currentTarget.getBoundingClientRect()
    const side: 'left' | 'right' = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'
    const now = Date.now()

    const last = lastTapRef.current
    const isDoubleTap = !!last && now - last.time < DOUBLE_TAP_MS && last.side === side

    if (isDoubleTap) {
      // Cancel the pending single-tap play/pause toggle.
      if (pendingSingleTapRef.current !== null) {
        window.clearTimeout(pendingSingleTapRef.current)
        pendingSingleTapRef.current = null
      }

      const duration = effectiveDurationSeconds
      const delta = side === 'left' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
      const upperBound = duration > 0 ? duration : Number.MAX_SAFE_INTEGER
      const target = Math.min(upperBound, Math.max(0, (video.currentTime || 0) + delta))
      try {
        video.currentTime = target
      } catch {
        // ignore seek failures
      }
      currentTimeRef.current = target
      setCurrentTimeSeconds(target)

      seekChainAmountRef.current += SEEK_STEP_SECONDS
      triggerSeekIndicator(side, seekChainAmountRef.current)

      // Keep the chain alive so further taps on this side accumulate.
      lastTapRef.current = { time: now, side }
      return
    }

    // First tap: remember it, reset the chain, and delay the play/pause toggle so a
    // follow-up tap can still be recognised as a double-tap.
    lastTapRef.current = { time: now, side }
    seekChainAmountRef.current = 0
    if (pendingSingleTapRef.current !== null) {
      window.clearTimeout(pendingSingleTapRef.current)
    }
    pendingSingleTapRef.current = window.setTimeout(() => {
      pendingSingleTapRef.current = null
      const v = videoRef.current
      if (v) flashPlayPauseIcon(v.paused ? 'play' : 'pause')
      void togglePlayPause()
    }, DOUBLE_TAP_MS)
  }

  const stopHoldSpeedBoost = useCallback((pointerId?: number) => {
    if (typeof pointerId === 'number' && holdBoostPointerIdRef.current !== pointerId) return

    if (holdBoostTimeoutRef.current !== null) {
      window.clearTimeout(holdBoostTimeoutRef.current)
      holdBoostTimeoutRef.current = null
    }

    const wasBoosting = isHoldBoostingRef.current
    holdBoostPointerIdRef.current = null
    isHoldBoostingRef.current = false

    if (!wasBoosting) return

    setPlaybackSpeed(1.0)

    // Prevent the release click from toggling play/pause after a deliberate hold gesture.
    if (Date.now() - holdBoostStartMsRef.current > HOLD_SPEED_BOOST_DELAY_MS) {
      suppressNextToggleRef.current = true
    }
  }, [HOLD_SPEED_BOOST_DELAY_MS])

  const handleVideoPointerDown = useCallback((e: React.PointerEvent<HTMLVideoElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return

    const video = videoRef.current
    if (!video || video.paused) return

    if (holdBoostTimeoutRef.current !== null) {
      window.clearTimeout(holdBoostTimeoutRef.current)
      holdBoostTimeoutRef.current = null
    }

    holdBoostPointerIdRef.current = e.pointerId
    holdBoostStartMsRef.current = Date.now()
    isHoldBoostingRef.current = false
    holdBoostTimeoutRef.current = window.setTimeout(() => {
      if (holdBoostPointerIdRef.current !== e.pointerId) return
      if (!videoRef.current || videoRef.current.paused) return
      // A deliberate hold is not a tap — cancel any pending single-tap toggle.
      if (pendingSingleTapRef.current !== null) {
        window.clearTimeout(pendingSingleTapRef.current)
        pendingSingleTapRef.current = null
      }
      lastTapRef.current = null
      isHoldBoostingRef.current = true
      setPlaybackSpeed(2.0)
      holdBoostTimeoutRef.current = null
    }, HOLD_SPEED_BOOST_DELAY_MS)

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore pointer capture failures
    }
  }, [HOLD_SPEED_BOOST_DELAY_MS])

  const handleVideoPointerUp = useCallback((e: React.PointerEvent<HTMLVideoElement>) => {
    stopHoldSpeedBoost(e.pointerId)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore pointer capture release failures
    }
  }, [stopHoldSpeedBoost])

  const handleVideoPointerCancel = useCallback((e: React.PointerEvent<HTMLVideoElement>) => {
    stopHoldSpeedBoost(e.pointerId)
  }, [stopHoldSpeedBoost])

  const handleVideoLostPointerCapture = useCallback((e: React.PointerEvent<HTMLVideoElement>) => {
    stopHoldSpeedBoost(e.pointerId)
  }, [stopHoldSpeedBoost])

  useEffect(() => {
    if (!isPlaying && isHoldBoostingRef.current) {
      stopHoldSpeedBoost()
    }
  }, [isPlaying, stopHoldSpeedBoost])

  useEffect(() => {
    return () => {
      if (holdBoostTimeoutRef.current !== null) {
        window.clearTimeout(holdBoostTimeoutRef.current)
        holdBoostTimeoutRef.current = null
      }
      if (pendingSingleTapRef.current !== null) {
        window.clearTimeout(pendingSingleTapRef.current)
        pendingSingleTapRef.current = null
      }
      if (seekIndicatorTimeoutRef.current !== null) {
        window.clearTimeout(seekIndicatorTimeoutRef.current)
        seekIndicatorTimeoutRef.current = null
      }
      if (centerPulseTimeoutRef.current !== null) {
        window.clearTimeout(centerPulseTimeoutRef.current)
        centerPulseTimeoutRef.current = null
      }
      if (scrubSettleTimeoutRef.current !== null) {
        window.clearTimeout(scrubSettleTimeoutRef.current)
        scrubSettleTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (volume > 0) {
      lastNonZeroVolumeRef.current = volume
    }
  }, [volume])

  useEffect(() => {
    return () => {
      if (volumeSliderCloseTimeoutRef.current) {
        window.clearTimeout(volumeSliderCloseTimeoutRef.current)
        volumeSliderCloseTimeoutRef.current = null
      }
    }
  }, [])

  const openVolumeSlider = () => {
    if (volumeSliderCloseTimeoutRef.current) {
      window.clearTimeout(volumeSliderCloseTimeoutRef.current)
      volumeSliderCloseTimeoutRef.current = null
    }
    setShowVolumeSlider(true)
  }

  const scheduleCloseVolumeSlider = () => {
    if (volumeSliderCloseTimeoutRef.current) {
      window.clearTimeout(volumeSliderCloseTimeoutRef.current)
    }
    volumeSliderCloseTimeoutRef.current = window.setTimeout(() => {
      setShowVolumeSlider(false)
      volumeSliderCloseTimeoutRef.current = null
    }, 120)
  }

  const toggleMute = () => {
    setIsMuted((prev) => {
      const nextMuted = !prev
      if (!nextMuted) {
        // If unmuting from volume 0, restore a usable volume.
        setVolume((v) => (v > 0 ? v : (lastNonZeroVolumeRef.current > 0 ? lastNonZeroVolumeRef.current : 0.5)))
      }
      return nextMuted
    })
  }

  const handleControlsPointerDownCapture = (e: any) => {
    // Close the volume slider whenever the user interacts with other controls.
    // Keep it open when interacting with the volume button/slider itself.
    const target = e?.target as Element | null
    if (!target) return
    if (target.closest?.('[data-volume-control="true"]')) return
    setShowVolumeSlider(false)
  }

  const handleDecreaseSpeed = () => {
    setPlaybackSpeed((prev) => Math.max(0.25, prev - 0.25))
  }

  const handleIncreaseSpeed = () => {
    setPlaybackSpeed((prev) => Math.min(2.0, prev + 0.25))
  }

  const isTimelineSeekSuppressed = useCallback(() => {
    return Date.now() < suppressTimelineSeekUntilRef.current
  }, [])

  // Suppress the trailing onClick seek that fires after a pointer gesture on the
  // timeline (a range-handle drag, or a playhead click/drag release that already
  // issued its own single seek). Wrapped so the impure Date.now() isn't called in
  // render (react-hooks/purity).
  const suppressNextTimelineSeek = useCallback(() => {
    suppressTimelineSeekUntilRef.current = Date.now() + 250
  }, [])

  // Safety check: if no videos available, show message
  if (!selectedVideo || displayVideos.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No videos available
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col',
        fillContainer
          ? `h-full min-h-0 ${mobileFullHeight ? 'max-h-[100dvh]' : 'max-h-[90dvh]'} lg:max-h-none`
          : fitToContainerHeight
            ? 'gap-4 min-h-0 h-full'
            : 'space-y-4 max-h-full'
      )}
      style={
        !isInFullscreen && fitToContainerHeight && fitMaxHeightDvh
          ? { maxHeight: fitMaxHeightDvh }
          : undefined
      }
    >
      <div
        ref={playerContainerRef}
        data-video-player-container="true"
        className={

          isInFullscreen
            ? 'fixed inset-0 z-50 bg-black flex flex-col p-3'
            : cn(
              'flex flex-col',
              fillContainer
                ? `flex-1 min-h-0 gap-3${pinControlsToBottom ? '' : ' lg:justify-center'}`
                : fitToContainerHeight
                  ? 'gap-4 min-h-0 h-full'
                  : 'space-y-4'
            )
        }
      >
        {/* Video Player */}
        <div
          className={
            isInFullscreen
              ? 'relative bg-black overflow-hidden flex-1 min-h-0'
              : cn(
                'bg-background min-h-0',
                fillContainer
                  ? `relative overflow-hidden flex items-center justify-center flex-1 w-full min-h-0${pinControlsToBottom ? '' : ' lg:flex-initial'}`
                  : 'flex items-center justify-center',
                !fillContainer && (fitToContainerHeight
                  ? 'relative overflow-hidden flex-1'
                  : 'flex-shrink')
              )
          }
          style={
            !isInFullscreen && fillContainer
              ? {
                  containerType: 'size',
                  aspectRatio: videoAspectRatio,
                } as React.CSSProperties
              : undefined
          }
        >
          <div
            ref={playerFrameBoxRef}
            className={
              isInFullscreen
                ? 'relative w-full h-full'
                : cn(
                    'relative bg-background overflow-hidden',
                    fillContainer
                      ? 'rounded-lg'
                      : cn('rounded-lg', fitToContainerHeight ? 'w-full h-full' : '')
                )
            }
            style={
              isInFullscreen
                ? undefined
                : fillContainer
                  ? {
                      width: `min(100cqw, calc(100cqh * ${videoAspectRatio}))`,
                      height: `min(100cqh, calc(100cqw / ${videoAspectRatio}))`,
                    }
                  : fitToContainerHeight
                    ? (videoAspectRatio < 1
                      ? {
                        height: '100%',
                        width: 'auto',
                        maxWidth: '100%',
                        aspectRatio: videoAspectRatio,
                      }
                      : undefined)
                    : {
                      maxHeight: nonFitMaxHeightDvh,
                      // Keep the correct aspect ratio but ensure portrait videos never exceed the viewport.
                      // If the video is taller than the available height, shrink the width to match.
                      width: `min(100%, calc(${nonFitMaxHeight} * ${videoAspectRatio}))`,
                      aspectRatio: videoAspectRatio,
                    }
            }
            // Block the native long-press/right-click "Save/Download Video" menu at the
            // wrapper too (mirrors the asset lightbox, which suppresses it on both the
            // <video> and its container). Non-admin only, so admins keep native save.
            onContextMenu={!isAdmin ? (e) => e.preventDefault() : undefined}
          >
            {selectedVideoHlsUrl ? (
              <video
                key={selectedVideo?.id}
                ref={videoRef}
                src={videoElementSrc}
                // Show the thumbnail (custom if set, otherwise the default) as the native
                // poster on first load. Only suppress it when an autoplay request is pending
                // for this video (responsive/mobile folder click) so it never flashes before
                // the first frame. Desktop keeps the poster until the user presses play.
                poster={autoPlayRequestRef.current === selectedVideo?.id ? undefined : (selectedVideo.thumbnailUrl || undefined)}
                className="w-full h-full"
                onTimeUpdate={handleTimeUpdate}
                onCanPlay={(e) => {
                  // Fulfil a pending folder-click autoplay request as soon as the new
                  // source can play, seeking to the requested time first (usually 0).
                  if (autoPlayRequestRef.current && autoPlayRequestRef.current === selectedVideo?.id) {
                    autoPlayRequestRef.current = null
                    const el = e.currentTarget
                    const seek = autoPlaySeekRef.current || 0
                    try {
                      if (seek > 0) {
                        el.currentTime = seek
                        currentTimeRef.current = seek
                      }
                    } catch {
                      // ignore seek failures
                    }
                    void startAutoPlay(el)
                  }
                }}
                onError={() => {
                  // A failed source (e.g. an expired token on the native-HLS path) leaves the
                  // element unplayable even on a manual retry. Ask the parent to re-mint tokens,
                  // but only once per source to avoid an error→refresh→error loop.
                  const vid = selectedVideo?.id
                  if (!vid || !selectedVideoHlsUrl) return
                  if (streamErrorRecoveryRef.current === vid) return
                  streamErrorRecoveryRef.current = vid
                  onStreamError?.(vid)
                }}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget

                  // Source loaded successfully — clear any pending recovery latch so a future
                  // failure can trigger another refresh.
                  if (streamErrorRecoveryRef.current === selectedVideo?.id) {
                    streamErrorRecoveryRef.current = null
                  }

                  if (Number.isFinite(el.duration)) {
                    setDurationSeconds(el.duration)
                  }
                  setCurrentTimeSeconds(el.currentTime || 0)

                  // Update wrapper aspect ratio from metadata only when DB dimensions are missing.
                  // Some media can report dimensions differently (e.g., rotation metadata), which can cause
                  // a visible resize/jump after initial render.
                  if (!hasTrustedAspectRatioRef.current) {
                    const w = el.videoWidth
                    const h = el.videoHeight
                    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                      setVideoAspectRatio(w / h)
                    } else {
                      setVideoAspectRatio(DEFAULT_ASPECT_RATIO)
                    }
                  }

                  // Ensure volume state is applied to new element
                  el.muted = isMuted
                  el.volume = Math.min(1, Math.max(0, volume))
                }}
                onPlay={() => {
                  setIsPlaying(true)
                  window.dispatchEvent(new CustomEvent('videoPlaybackStarted'))

                  // Track a video view (play) for share-token sessions only.
                  // Guest-video-link views are tracked server-side (with IP dedupe).
                  try {
                    if (isAdmin) return
                    if (!shareToken) return
                    const videoId = selectedVideo?.id
                    if (!videoId) return
                    void fetch('/api/track/video-view', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${shareToken}`,
                      },
                      body: JSON.stringify({ videoId }),
                    }).catch(() => {})
                  } catch {
                    // best-effort
                  }
                }}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onContextMenu={suppressDownloadUi ? (e) => e.preventDefault() : undefined}
                playsInline
                preload={!isAdmin || hideDownloadButton ? 'auto' : 'metadata'}
                onPointerDown={handleVideoPointerDown}
                onPointerUp={handleVideoPointerUp}
                onPointerCancel={handleVideoPointerCancel}
                onLostPointerCapture={handleVideoLostPointerCapture}
                onClick={handleVideoClick}
                // Mirror the asset lightbox's proven recipe for suppressing the native
                // "Save/Download Video" menu on non-admin players: fuller controlsList,
                // disable PiP, block the context menu on the element, and the iOS-only
                // touch-callout CSS. The long-press-to-2x gesture is pointer-event based,
                // so it keeps working.
                controlsList={suppressDownloadUi ? 'nodownload noplaybackrate noremoteplayback' : undefined}
                disablePictureInPicture={suppressDownloadUi}
                style={{
                  objectFit: 'contain',
                  backgroundColor: isLgViewport ? '#000' : 'transparent',
                  // Stop the browser from claiming a finger-drag as a scroll/pan gesture,
                  // which would fire pointercancel mid-hold and drop the 2x speed boost.
                  // Also suppresses native double-tap-zoom (helps the double-tap-to-seek).
                  touchAction: 'none',
                  ...(suppressDownloadUi
                    ? { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }
                    : {}),
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-card-foreground">
                {hlsWaitElapsed ? 'This video is currently not available.' : 'Preparing video stream…'}
              </div>
            )}

            {showPosterOverlay && selectedVideo?.thumbnailUrl ? (
              <Image
                alt="Video thumbnail"
                src={selectedVideo.thumbnailUrl}
                fill
                unoptimized
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{
                  objectFit: 'contain',
                  backgroundColor: isLgViewport ? '#000' : 'transparent',
                }}
              />
            ) : null}

            {/* Scrub sprite overlay — while dragging the playhead or a comment IN/OUT
                marker WITHOUT Shift, show the lightweight timeline sprite tile stretched
                over the player instead of seeking the real (full-resolution) video. The
                sprite tile shares the video's aspect ratio, so we letterbox it to fit the
                player exactly like the <video>. Holding Shift (precision) hides this and
                lets the real seeked frame show through. Reuses the cue already computed in
                `timelineHover` for the current drag time. */}
            {(isScrubbingPlayhead || activeRangeDragHandle !== null || scrubSettling)
              && (!isPrecisionDragging || !precisionFrameReady)
              && timelineHover.visible
              && timelineHover.spriteUrl
              && playerFrameBoxSize.w > 0
              && timelineHover.w > 0
              && timelineHover.h > 0
              && (() => {
                const boxW = playerFrameBoxSize.w
                const boxH = playerFrameBoxSize.h
                const tileAspect = timelineHover.w / timelineHover.h
                // Letterbox the tile inside the player box (object-fit: contain).
                let dispW = boxW
                let dispH = boxW / tileAspect
                if (dispH > boxH) {
                  dispH = boxH
                  dispW = boxH * tileAspect
                }
                const scale = dispW / timelineHover.w
                return (
                  <div
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                    style={{ backgroundColor: isLgViewport ? '#000' : 'transparent' }}
                  >
                    <div
                      style={{
                        width: dispW,
                        height: dispH,
                        backgroundImage: `url(${timelineHover.spriteUrl})`,
                        backgroundSize: `${dispW * 10}px auto`,
                        backgroundPosition: `-${Math.round(timelineHover.x * scale)}px -${Math.round(timelineHover.y * scale)}px`,
                        backgroundRepeat: 'no-repeat',
                      }}
                    />
                  </div>
                )
              })()}

            {/* Playback Speed Indicator - Show when speed is not 1.0x */}
            {playbackSpeed !== 1.0 && (
              <div className="absolute top-4 right-4 bg-black/80 text-white px-3 py-1.5 rounded-md text-sm font-medium pointer-events-none">
                {playbackSpeed.toFixed(2)}x
              </div>
            )}

            {/* Double-tap seek indicator (YouTube-style) on the tapped half. */}
            {seekIndicator && (
              <div
                key={seekIndicator.key}
                className={cn(
                  'absolute inset-y-0 w-1/2 flex flex-col items-center justify-center gap-1 pointer-events-none text-white',
                  seekIndicator.side === 'left' ? 'left-0' : 'right-0',
                )}
                style={{ animation: 'yt-seek-pop 1200ms ease-out forwards' }}
              >
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-black/60">
                  {seekIndicator.side === 'left' ? (
                    <Rewind className="w-8 h-8 fill-current" />
                  ) : (
                    <FastForward className="w-8 h-8 fill-current" />
                  )}
                </div>
                <span className="text-sm font-medium drop-shadow">{seekIndicator.amount} seconds</span>
              </div>
            )}

            {/* Centred play/pause flash on single tap. */}
            {centerPulse && (
              <div
                key={centerPulse.key}
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                <div
                  className="flex items-center justify-center w-16 h-16 rounded-full bg-black/60 text-white"
                  style={{ animation: 'yt-tap-pulse 1000ms ease-out forwards' }}
                >
                  {centerPulse.kind === 'play' ? (
                    <Play className="w-8 h-8 fill-current" />
                  ) : (
                    <Pause className="w-8 h-8 fill-current" />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Custom Controls + Timeline (enables hover thumbnails) */}
        <div
          className="relative flex-shrink-0 pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] lg:px-0"
          style={!isInFullscreen && controlsBottomPadding ? { paddingBottom: controlsBottomPadding } : undefined}
        >
          <div
            className="flex flex-col gap-2 pt-4 lg:pt-0"
            onPointerDownCapture={handleControlsPointerDownCapture}
          >
            {/* Desktop/tablet: left controls — hidden; controls are now rendered below the timeline */}
            <div className="hidden">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </Button>

              <div
                className="relative flex-shrink-0"
                data-volume-control="true"
                onMouseEnter={openVolumeSlider}
                onMouseLeave={scheduleCloseVolumeSlider}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleMute}
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                  className="relative overflow-hidden w-14 px-0"
                >
                  {Math.round(volume * 100) > 0 && Math.round(volume * 100) < 100 && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 bg-primary/30"
                      style={{ width: `${Math.round(volume * 100)}%` }}
                    />
                  )}
                  <span className="relative z-10">
                    {isMuted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
                  </span>
                </Button>

                {showVolumeSlider && (
                  <div
                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 rounded-lg border border-border bg-card p-2 shadow-elevation-sm"
                    onMouseEnter={openVolumeSlider}
                    onMouseLeave={scheduleCloseVolumeSlider}
                  >
                    <div className="h-28 w-10 flex items-center justify-center">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(volume * 100)}
                      onChange={(e) => {
                        const next = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0))
                        const nextVolume = next / 100
                        setVolume(nextVolume)
                        if (nextVolume > 0) {
                          setIsMuted(false)
                        }
                      }}
                      className="w-28 h-4 -rotate-90 accent-primary touch-none"
                      style={{ touchAction: 'none' }}
                      aria-label="Volume"
                    />
                    </div>
                  </div>
                )}
              </div>

              {!shouldHideSpeedControls && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDecreaseSpeed}
                    aria-label="Decrease playback speed"
                    className={cn(playbackSpeed !== 1.0 && playbackSpeed < 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                  >
                    <Rewind className="w-4 h-4" />
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleIncreaseSpeed}
                    aria-label="Increase playback speed"
                    className={cn(playbackSpeed !== 1.0 && playbackSpeed > 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                  >
                    <FastForward className="w-4 h-4" />
                  </Button>
                </>
              )}

              <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap flex items-center gap-0.5">
                <span>
                  {formatTimestampDisplay(currentTimeSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)} /{' '}
                  {formatTimestampDisplay(effectiveDurationSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)}
                </span>
                {showTimeDisplayToggle && (
                <div className="relative time-display-toggle">
                  <button
                    type="button"
                    className="inline-flex items-center text-muted-foreground/60 hover:text-muted-foreground transition-colors p-0 bg-transparent border-0 cursor-pointer"
                    onClick={() => setShowTimeDisplayMenu((v) => !v)}
                    aria-label="Toggle time display format"
                    title="Switch between duration and timecode"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showTimeDisplayMenu && (
                    <div className="time-display-menu absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-md shadow-md py-1 z-50 min-w-[100px]">
                      <button
                        type="button"
                        className={cn(
                          'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                          timeDisplayMode === 'duration' && 'text-foreground font-medium',
                        )}
                        onClick={() => toggleTimeDisplayMode('duration')}
                      >
                        Duration
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                          timeDisplayMode === 'timecode' && 'text-foreground font-medium',
                          (!effectiveFps || effectiveFps <= 0) && 'text-muted-foreground/40 pointer-events-none',
                        )}
                        onClick={() => effectiveFps && effectiveFps > 0 && toggleTimeDisplayMode('timecode')}
                        title={!effectiveFps || effectiveFps <= 0 ? 'Timecode requires FPS metadata on this video' : undefined}
                      >
                        Timecode
                      </button>
                    </div>
                  )}
                </div>
                )}
              </div>
            </div>

            {/* Timeline — inset on both sides so the playhead ball and the IN/OUT
                brackets render fully at 0:00 / the end instead of being clipped.
                The bar fills this wrapper, so the hover-preview offsets (computed
                relative to the bar) stay aligned with the wrapper. */}
            <div className="relative" style={{ marginLeft: TIMELINE_EDGE_INSET_PX, marginRight: TIMELINE_EDGE_INSET_PX }}>
              <div
                ref={scrubBarRef}
                className="h-4 rounded-md bg-muted/40 border border-border cursor-pointer relative overflow-visible touch-none select-none"
                onPointerEnter={(e) => {
                  if (!canShowTimelineHover) return
                  updateHoverFromClientX(e.clientX)
                }}
                onPointerMove={(e) => {
                  if (isScrubbingRef.current) {
                    if (e.buttons === 0) { // released outside our handlers — abort stale scrub
                      isScrubbingRef.current = false
                      scrubDidMoveRef.current = false
                      setIsScrubbingPlayhead(false)
                      clearPrecisionAnchor()
                      return
                    }
                    e.preventDefault()
                    // Engage drag visuals + live seeking only once the pointer moves
                    // past the click threshold, so a plain click never shows the sprite.
                    if (!scrubDidMoveRef.current) {
                      if (Math.abs(e.clientX - scrubStartClientXRef.current) < SCRUB_DRAG_THRESHOLD_PX) return
                      scrubDidMoveRef.current = true
                      setIsScrubbingPlayhead(true)
                    }
                    syncPrecisionAnchor(e.clientX, e.shiftKey)
                    scheduleScrubToClientX(e.clientX)
                    return
                  }

                  // While hovering the playhead/IN/OUT element, keep its neutral
                  // time preview — don't recompute from the cursor position.
                  if (hoveredTimelineTargetRef.current) return

                  if (!canShowTimelineHover) return
                  updateHoverFromClientX(e.clientX)
                }}
                onPointerLeave={() => {
                  isScrubbingRef.current = false
                  setIsScrubbingPlayhead(false)
                  clearPrecisionAnchor()
                  if (keepTimelineHoverPinnedRef.current) return
                  setTimelineHover((prev) => ({ ...prev, visible: false }))
                  setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                }}
                onPointerDown={(e) => {
                  if (isTimelineSeekSuppressed()) {
                    e.preventDefault()
                    return
                  }
                  e.preventDefault()
                  isRangeFramePreviewActiveRef.current = false
                  rangeFramePreviewOriginalPlayheadRef.current = null
                  keepTimelineHoverPinnedRef.current = false
                  // If the user is seeking, show actual video frames (not the poster overlay).
                  setShowPosterOverlay(false)
                  ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
                  isScrubbingRef.current = true
                  scrubStartClientXRef.current = e.clientX
                  scrubDidMoveRef.current = false
                  // Cancel any lingering release bridge from a previous gesture so its
                  // safety timeout can't fire mid-drag.
                  if (scrubSettleTimeoutRef.current !== null) {
                    window.clearTimeout(scrubSettleTimeoutRef.current)
                    scrubSettleTimeoutRef.current = null
                  }
                  scrubSettlingRef.current = false
                  setScrubSettling(false)
                  precisionUsedThisGestureRef.current = false
                  // Move the playhead UI (ball + time) to the press position right away,
                  // so a click-and-hold updates the playhead before any mouse movement.
                  // The real <video> seek is still deferred to release (or a drag) and no
                  // sprite overlay is shown, so only the indicator moves — no flash.
                  {
                    const { time, width } = getTimeFromScrubEvent(e.clientX)
                    const snapped = snapPlayheadToHandles(time, width)
                    currentTimeRef.current = snapped
                    setCurrentTimeSeconds(snapped)
                  }
                  // Don't seek or show the sprite yet — wait to see if this becomes a
                  // drag (movement past the threshold) or a plain click (a single seek
                  // on release). This keeps a click from flashing the scrub sprite.
                }}
                onPointerUp={(e) => {
                  try {
                    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                  } catch {}
                  isScrubbingRef.current = false
                  setIsScrubbingPlayhead(false)
                  // Precision (Shift) drags seek the real video live and bridge the
                  // reveal via precisionFrameReady — leave that path untouched (its
                  // trailing click is skipped by precisionUsedThisGestureRef).
                  if (precisionUsedThisGestureRef.current) {
                    clearPrecisionAnchor()
                    if (!canShowTimelineHover) {
                      setTimelineHover((prev) => ({ ...prev, visible: false }))
                    }
                    return
                  }
                  clearPrecisionAnchor()
                  const wasDrag = scrubDidMoveRef.current
                  scrubDidMoveRef.current = false
                  // Collapse the gesture into exactly ONE seek, issued synchronously
                  // here. Cancel any pending scrub RAF and suppress the trailing onClick
                  // so the playhead is never seeked twice — a double seek produced a
                  // double frame-flash on a plain click.
                  if (scrubRafRef.current != null) {
                    window.cancelAnimationFrame(scrubRafRef.current)
                    scrubRafRef.current = null
                  }
                  pendingScrubClientXRef.current = null
                  const video = videoRef.current
                  if (video) {
                    const { time, width } = getTimeFromScrubEvent(e.clientX)
                    const snapped = snapPlayheadToHandles(time, width)
                    // A non-precision drag only moved the UI playhead (currentTimeRef);
                    // the real <video> was NOT seeked. So land the seek by comparing
                    // against the video's ACTUAL position, not currentTimeRef (which is
                    // already at the dragged spot) — otherwise the seek is skipped and
                    // playback resumes from the old position.
                    if (Math.abs(snapped - video.currentTime) > 0.001) {
                      try { video.currentTime = snapped } catch {}
                    }
                    currentTimeRef.current = snapped
                    setCurrentTimeSeconds(snapped)
                  }
                  suppressNextTimelineSeek()
                  if (wasDrag) {
                    // The sprite overlay was covering the player during the drag — hold
                    // it until this final seek lands, so the swap to the real frame is a
                    // single clean cut (no pre-seek flash).
                    beginScrubSettle()
                  } else {
                    // Plain click: no sprite was shown. Let the <video> seek directly —
                    // the browser holds the current frame until the new one decodes, so
                    // there's nothing to bridge.
                    if (!canShowTimelineHover) {
                      setTimelineHover((prev) => ({ ...prev, visible: false }))
                    }
                  }
                }}
                onPointerCancel={(e) => {
                  try {
                    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                  } catch {}
                  isScrubbingRef.current = false
                  setIsScrubbingPlayhead(false)
                  clearPrecisionAnchor()
                  finishScrubSettle()
                  setTimelineHover((prev) => ({ ...prev, visible: false }))
                  setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                }}
                onClick={(e) => {
                  if (isTimelineSeekSuppressed()) {
                    e.preventDefault()
                    e.stopPropagation()
                    return
                  }
                  // After a precision (Shift) drag the playhead already sits at the
                  // fine-tuned spot; the trailing click's raw cursor position is coarse,
                  // so skip it to avoid yanking the playhead back to the mouse.
                  if (precisionUsedThisGestureRef.current) {
                    precisionUsedThisGestureRef.current = false
                    return
                  }
                  // If the user is seeking, show actual video frames (not the poster overlay).
                  setShowPosterOverlay(false)
                  isRangeFramePreviewActiveRef.current = false
                  rangeFramePreviewOriginalPlayheadRef.current = null
                  if (videoRef.current) {
                    const { time, width } = getTimeFromScrubEvent(e.clientX)
                    // Apply the same IN/OUT snap as scrubbing, so the click that fires
                    // after a drag-release lands on the snapped position instead of
                    // nudging the playhead back to the raw cursor location.
                    const snapped = snapPlayheadToHandles(time, width)
                    videoRef.current.currentTime = snapped
                    currentTimeRef.current = snapped
                    setCurrentTimeSeconds(snapped)
                  }
                }}
              >
                <div
                  className="absolute left-0 top-0 h-full bg-primary rounded-md"
                  style={{
                    width: effectiveDurationSeconds > 0
                      ? `${Math.min(100, Math.max(0, (currentTimeSeconds / effectiveDurationSeconds) * 100))}%`
                      : '0%'
                  }}
                />

                {/* Playhead thumb (YouTube-style) — visible ball at the current position
                    that grows only when the ball itself is hovered (not anywhere on the
                    bar). It sits above the comment range markers (z-25 > z-20) so it stays
                    grabbable and centered over their inner edges; the markers stay grabbable
                    on the parts that extend outward beyond the ball. It is pointer-events-auto
                    and grabbable: a press bubbles up to the scrub bar's existing pointer
                    handlers, so dragging the ball drives seeking exactly like dragging the
                    bar. */}
                {effectiveDurationSeconds > 0 && (
                  <div
                    className="pointer-events-auto absolute top-1/2 z-[25] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-md ring-2 ring-background transition-[width,height] duration-100 ease-out h-3 w-3 hover:h-[18px] hover:w-[18px] cursor-grab active:cursor-grabbing"
                    style={{
                      left: `${Math.min(100, Math.max(0, (currentTimeSeconds / effectiveDurationSeconds) * 100))}%`,
                    }}
                    onPointerEnter={(e) => {
                      if (e.pointerType !== 'mouse' || isScrubbingRef.current) return
                      setHoverTimelineTarget('playhead')
                      updateHoverFromTimeSeconds(currentTimeRef.current, 96, true)
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType !== 'mouse') return
                      if (hoveredTimelineTargetRef.current === 'playhead') setHoverTimelineTarget(null)
                    }}
                  />
                )}

                {/* Comment range overlay — shown when user starts typing a comment */}
                {commentRangeActive && effectiveDurationSeconds > 0 && (
                  <>
                    {/* Amber fill between handles */}
                    {(commentRangeEnd - commentRangeStart) >= 0.5 && (
                      <div
                        className="absolute top-0 h-full bg-amber-400/30 pointer-events-none z-5"
                        style={{
                          left: `${Math.min(100, Math.max(0, (commentRangeStart / effectiveDurationSeconds) * 100))}%`,
                          width: `${Math.min(100, Math.max(0, ((commentRangeEnd - commentRangeStart) / effectiveDurationSeconds) * 100))}%`,
                        }}
                      />
                    )}

                    {/* IN handle (left) — solid amber rectangle whose right edge sits at the
                        current time. The playhead ball renders on top (higher z), centered
                        on the same point, so the marker reads as the range start beside it. */}
                    <div
                      className="absolute z-20 bg-amber-400 rounded-l-sm cursor-ew-resize touch-none animate-comment-range-handle-left-nudge motion-reduce:animate-none"
                      style={{ left: `${Math.min(100, Math.max(0, (commentRangeStart / effectiveDurationSeconds) * 100))}%`, top: '50%', transform: 'translateX(-100%) translateY(-50%)', width: RANGE_HANDLE_WIDTH_PX, height: RANGE_HANDLE_HEIGHT_PX }}
                      onPointerEnter={(e) => {
                        if (e.pointerType !== 'mouse' || draggingRangeHandle.current) return
                        setHoverTimelineTarget('rangeStart')
                        updateHoverFromTimeSeconds(commentRangeStartRef.current, 96, true)
                      }}
                      onPointerLeave={(e) => {
                        if (e.pointerType !== 'mouse') return
                        if (hoveredTimelineTargetRef.current === 'rangeStart') setHoverTimelineTarget(null)
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        keepTimelineHoverPinnedRef.current = true
                        beginRangeFramePreview()
                        draggingRangeHandle.current = 'start'
                        setActiveRangeDragHandle('start')
                        commentPointFollowsPlayheadRef.current = false
                        videoRef.current?.pause()
                      }}
                      onPointerMove={(e) => {
                        if (draggingRangeHandle.current !== 'start') return
                        if (e.buttons === 0) { // released outside our handlers — abort stale drag
                          draggingRangeHandle.current = null
                          setActiveRangeDragHandle(null)
                          keepTimelineHoverPinnedRef.current = false
                          clearPrecisionAnchor()
                          return
                        }
                        syncPrecisionAnchor(e.clientX, e.shiftKey)
                        const { time, width } = getTimeFromScrubEvent(e.clientX)
                        const snapped = snapHandleTimeToPlayhead(time, width)
                        const newStart = Math.max(0, Math.min(snapped, commentRangeEnd - 0.1))
                        setCommentRangeStart(newStart)
                        commentRangeStartRef.current = newStart
                        const separation = commentRangeEnd - newStart
                        commentRangeHasExplicitSelectionRef.current = separation >= 0.5
                        // Only propagate an 'end' once the handles are meaningfully apart.
                        window.dispatchEvent(new CustomEvent('commentRangeChanged', {
                          detail: { start: newStart, ...(commentRangeHasExplicitSelectionRef.current ? { end: commentRangeEnd } : {}) }
                        }))
                        // Only a precision (Shift) drag seeks the real video for an
                        // exact frame; the default drag shows the sprite tile instead.
                        if (precisionDragAnchorRef.current) previewVideoFrameAt(newStart)
                        // Mirror the playhead-snap feel: while snapped, hold the preview at
                        // the committed (snapped) time instead of tracking the cursor, so a
                        // tiny move inside the snap zone doesn't jiggle the displayed time.
                        if (snapped !== time) {
                          updateHoverFromTimeSeconds(newStart, 96, true)
                        } else {
                          updateHoverFromClientX(e.clientX, true)
                        }
                      }}
                      onPointerUp={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                        draggingRangeHandle.current = null
                        setActiveRangeDragHandle(null)
                        keepTimelineHoverPinnedRef.current = false
                        clearPrecisionAnchor()
                        suppressNextTimelineSeek()
                        updateHoverFromTimeSeconds(commentRangeStartRef.current, 96)
                      }}
                      onPointerCancel={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                        draggingRangeHandle.current = null
                        setActiveRangeDragHandle(null)
                        keepTimelineHoverPinnedRef.current = false
                        clearPrecisionAnchor()
                        suppressNextTimelineSeek()
                        updateHoverFromTimeSeconds(commentRangeStartRef.current, 96)
                      }}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    />

                    {/* OUT handle (right) — solid amber rectangle whose left edge sits at the
                        current time. The playhead ball renders on top (higher z), centered
                        on the same point, so the marker reads as the range end beside it. */}
                    <div
                      className="absolute z-20 bg-amber-400 rounded-r-sm cursor-ew-resize touch-none animate-comment-range-handle-right-nudge motion-reduce:animate-none"
                      style={{ left: `${Math.min(100, Math.max(0, (commentRangeEnd / effectiveDurationSeconds) * 100))}%`, top: '50%', transform: 'translateX(0) translateY(-50%)', width: RANGE_HANDLE_WIDTH_PX, height: RANGE_HANDLE_HEIGHT_PX }}
                      onPointerEnter={(e) => {
                        if (e.pointerType !== 'mouse' || draggingRangeHandle.current) return
                        setHoverTimelineTarget('rangeEnd')
                        // Until the user has dragged out an explicit range, IN and OUT
                        // both represent the single point at the playhead — show that
                        // time, not the OUT handle's slightly-offset visual position.
                        const outTime = commentRangeHasExplicitSelectionRef.current
                          ? commentRangeEndRef.current
                          : commentRangeStartRef.current
                        updateHoverFromTimeSeconds(outTime, 96, true)
                      }}
                      onPointerLeave={(e) => {
                        if (e.pointerType !== 'mouse') return
                        if (hoveredTimelineTargetRef.current === 'rangeEnd') setHoverTimelineTarget(null)
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        keepTimelineHoverPinnedRef.current = true
                        beginRangeFramePreview()
                        draggingRangeHandle.current = 'end'
                        setActiveRangeDragHandle('end')
                        commentPointFollowsPlayheadRef.current = false
                        videoRef.current?.pause()
                      }}
                      onPointerMove={(e) => {
                        if (draggingRangeHandle.current !== 'end') return
                        if (e.buttons === 0) { // released outside our handlers — abort stale drag
                          draggingRangeHandle.current = null
                          setActiveRangeDragHandle(null)
                          keepTimelineHoverPinnedRef.current = false
                          clearPrecisionAnchor()
                          return
                        }
                        syncPrecisionAnchor(e.clientX, e.shiftKey)
                        const { time, width } = getTimeFromScrubEvent(e.clientX)
                        const snapped = snapHandleTimeToPlayhead(time, width)
                        const duration = effectiveDurationSeconds
                        const newEnd = Math.min(
                          duration > 0 ? duration : snapped,
                          Math.max(snapped, commentRangeStart + 0.1)
                        )
                        setCommentRangeEnd(newEnd)
                        commentRangeEndRef.current = newEnd
                        const separation = newEnd - commentRangeStart
                        commentRangeHasExplicitSelectionRef.current = separation >= 0.5
                        window.dispatchEvent(new CustomEvent('commentRangeChanged', {
                          detail: { start: commentRangeStart, ...(commentRangeHasExplicitSelectionRef.current ? { end: newEnd } : {}) }
                        }))
                        // Only a precision (Shift) drag seeks the real video for an
                        // exact frame; the default drag shows the sprite tile instead.
                        if (precisionDragAnchorRef.current) previewVideoFrameAt(newEnd)
                        // Mirror the playhead-snap feel: while snapped, hold the preview at
                        // the committed (snapped) time instead of tracking the cursor, so a
                        // tiny move inside the snap zone doesn't jiggle the displayed time.
                        if (snapped !== time) {
                          updateHoverFromTimeSeconds(newEnd, 96, true)
                        } else {
                          updateHoverFromClientX(e.clientX, true)
                        }
                      }}
                      onPointerUp={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                        draggingRangeHandle.current = null
                        setActiveRangeDragHandle(null)
                        keepTimelineHoverPinnedRef.current = false
                        clearPrecisionAnchor()
                        suppressNextTimelineSeek()
                        updateHoverFromTimeSeconds(commentRangeEndRef.current, 96)
                      }}
                      onPointerCancel={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                        draggingRangeHandle.current = null
                        setActiveRangeDragHandle(null)
                        keepTimelineHoverPinnedRef.current = false
                        clearPrecisionAnchor()
                        suppressNextTimelineSeek()
                        updateHoverFromTimeSeconds(commentRangeEndRef.current, 96)
                      }}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    />

                    {/* Dismiss ✕ — floats above the right (OUT) handle. Hidden whenever a
                        timeline preview for another element is showing (dragging a handle,
                        dragging the playhead, or hovering the playhead/IN/OUT) so it doesn't
                        sit under the cursor / preview — but stays visible when hovering the
                        ✕ itself (which shows its own destructive "Clear time range" preview). */}
                    {!activeRangeDragHandle && !isScrubbingPlayhead && (hoveredTimelineTarget === null || hoveredTimelineTarget === 'clear') && (
                    <button
                      type="button"
                      className="absolute z-30 flex items-center justify-center rounded-sm bg-amber-400 text-amber-900 hover:bg-amber-300 leading-none"
                      style={{
                        // Sit clear above the OUT marker (which now stands ~2px proud of the
                        // bar top), leaving an ~8px gap between the marker and the ✕.
                        top: '-24px',
                        left: `${Math.min(100, Math.max(0, (commentRangeEnd / effectiveDurationSeconds) * 100))}%`,
                        // Centre over the OUT marker (which extends half its width right of the point).
                        transform: `translateX(calc(-50% + ${RANGE_HANDLE_WIDTH_PX / 2}px))`,
                        width: '14px',
                        height: '14px',
                        fontSize: '10px',
                        lineHeight: 1,
                      }}
                      aria-label="Clear time range"
                      onPointerEnter={(e) => {
                        if (e.pointerType !== 'mouse') return
                        setHoverTimelineTarget('clear')
                        updateHoverFromTimeSeconds(commentRangeEndRef.current, 96, true)
                      }}
                      onPointerLeave={(e) => {
                        if (e.pointerType !== 'mouse') return
                        if (hoveredTimelineTargetRef.current === 'clear') setHoverTimelineTarget(null)
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
                      }}
                    >
                      ×
                    </button>
                    )}
                  </>
                )}

                {/* Range spans for comments that have a timecodeEnd — rendered below avatar dots */}
                {timelineCommentMarkers.some(m => m.timecodeEndSeconds !== null) && effectiveDurationSeconds > 0 && (
                  <div className="absolute inset-0 z-8 pointer-events-none">
                    {timelineCommentMarkers.filter(m => m.timecodeEndSeconds !== null).map((m) => {
                      const leftPct = Math.min(100, Math.max(0, (m.seconds / effectiveDurationSeconds) * 100))
                      const widthPct = Math.min(100 - leftPct, Math.max(0, ((m.timecodeEndSeconds! - m.seconds) / effectiveDurationSeconds) * 100))
                      return (
                        <div
                          key={`range-bar-${m.id}`}
                          className="absolute top-1/4 h-1/2 rounded-sm"
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            background: m.isInternal
                              ? 'rgba(100,116,139,0.45)'
                              : 'rgba(251,191,36,0.45)',
                            border: m.isInternal
                              ? '2px solid rgba(100,116,139,0.9)'
                              : '2px solid rgba(251,191,36,0.9)',
                          }}
                        />
                      )
                    })}
                  </div>
                )}

                {/* Comment markers */}
                {timelineCommentMarkers.length > 0 && effectiveDurationSeconds > 0 && (
                  <div className="absolute inset-0 z-10">
                    {timelineCommentMarkers.map((m) => {
                      const leftPct = Math.min(100, Math.max(0, (m.seconds / effectiveDurationSeconds) * 100))
                      const avatarColor = m.displayColor || (m.isInternal ? '#0f172a' : '#64748b')
                      const avatarName = (m.authorName || '').trim() || (m.isInternal ? 'Admin' : 'Client')

                      const position = (() => {
                        // Clamp markers at timeline edges so avatar circles are not cut off.
                        if (leftPct <= 2) {
                          return { left: '0%', transform: 'translate(0%, -50%)' }
                        }
                        if (leftPct >= 98) {
                          return { left: '100%', transform: 'translate(-100%, -50%)' }
                        }
                        return { left: `${leftPct}%`, transform: 'translate(-50%, -50%)' }
                      })()

                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="absolute top-1/2 bg-transparent opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100 active:opacity-100 focus-visible:outline-none"
                          style={position}
                          title="Jump to comment"
                          aria-label="Jump to comment"
                          onPointerEnter={(e) => {
                            if (!canShowTimelineHover) return
                            e.stopPropagation()

                            // Align both thumbnail and comment tooltip to the marker timestamp,
                            // not the current pointer X (prevents drift for longer tooltips).
                            const hoverLeftPx = updateHoverFromTimeSeconds(m.seconds, 260)
                            const leftPx = hoverLeftPx ?? getLeftPxForSeconds(m.seconds, 260)
                            setTimelineCommentHover({
                              visible: true,
                              leftPx,
                              commentId: m.id,
                            })
                          }}
                          onPointerLeave={(e) => {
                            if (!canShowTimelineHover) return
                            e.stopPropagation()
                            setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                          }}
                          onClick={(e) => {
                            e.stopPropagation()

                            // If the user is seeking, show actual video frames (not the poster overlay).
                            setShowPosterOverlay(false)

                            // Seek video to the comment timecode (do not auto-play)
                            if (videoRef.current) {
                              try {
                                videoRef.current.currentTime = m.seconds
                                currentTimeRef.current = m.seconds
                                setCurrentTimeSeconds(m.seconds)

                                // Always pause when jumping to a comment marker
                                videoRef.current.pause()
                              } catch {
                                // ignore
                              }
                            }

                            window.dispatchEvent(
                              new CustomEvent('scrollToComment', {
                                detail: { commentId: m.id },
                              })
                            )
                          }}
                          onPointerDown={(e) => {
                            // Prevent scrubbing when clicking a marker
                            e.stopPropagation()
                          }}
                        >
                          <span className="relative block">
                            <InitialsAvatar
                              name={avatarName}
                              email={m.authorEmail || null}
                              displayColor={avatarColor}
                              avatarUrl={m.avatarUrl}
                              className="h-[30px] w-[30px] sm:h-[24px] sm:w-[24px] text-[10px] sm:text-[9px] ring-2"
                            />

                            {m.replyCount > 0 ? (
                              <span
                                className="absolute -top-1 -right-1 grid h-4 w-4 sm:h-3.5 sm:w-3.5 place-items-center rounded-full bg-white text-[10px] sm:text-[9px] font-semibold text-black border border-black"
                                title={`${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`}
                              >
                                {m.replyCount}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {((timelineCues.length > 0 && timelineHover.visible && timelineHover.spriteUrl) ||
                (timelineCommentHover.visible && hoveredBaseCommentForTimeline)) && (
                <div
                  className="absolute bottom-full mb-2 pointer-events-none z-20 flex flex-col items-center"
                  style={{
                    left:
                      timelineCues.length > 0 && timelineHover.visible && timelineHover.spriteUrl
                        ? timelineHover.leftPx
                        : timelineCommentHover.leftPx,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {timelineCommentHover.visible && hoveredBaseCommentForTimeline && (
                    <div className="mb-2 max-w-[260px] rounded-md border border-border bg-card px-3 py-2 shadow-elevation-sm">
                      <div className="text-xs font-medium text-card-foreground">
                        {String((hoveredBaseCommentForTimeline as any)?.authorName ||
                          ((hoveredBaseCommentForTimeline as any)?.isInternal ? 'Studio' : 'Client'))}
                      </div>
                      <div
                        className="mt-0.5 text-xs text-muted-foreground leading-snug"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {getTimelineCommentPreviewText((hoveredBaseCommentForTimeline as any)?.content)}
                      </div>
                    </div>
                  )}

                  {timelineCues.length > 0 && timelineHover.visible && timelineHover.spriteUrl && (() => {
                    const maxW = 250
                    const maxH = 300
                    const scale = Math.min(maxW / timelineHover.w, maxH / timelineHover.h, 1)
                    const displayW = Math.round(timelineHover.w * scale)
                    const displayH = Math.round(timelineHover.h * scale)
                    // When dragging OR hovering a range handle / the playhead / the clear ✕,
                    // make the preview unmistakable: a thick coloured frame + label. Range
                    // uses the amber range colour ("Comment start/end point"); the playhead
                    // uses the primary app colour ("PLAYHEAD POSITION"); the clear ✕ uses the
                    // destructive red ("CLEAR TIME RANGE"). An active drag wins over a hover.
                    const dragKind = activeRangeDragHandle
                      ? (activeRangeDragHandle === 'start' ? 'rangeStart' : 'rangeEnd')
                      : isScrubbingPlayhead ? 'playhead' : null
                    const previewKind = dragKind ?? hoveredTimelineTarget
                    const isRangeKind = previewKind === 'rangeStart' || previewKind === 'rangeEnd'
                    const isClearKind = previewKind === 'clear'
                    const highlight = previewKind !== null
                    const rangeColor = '#fbbf24' // amber-400 — same as the range handles/fill
                    const accentColor = isRangeKind ? rangeColor : isClearKind ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'
                    const accentTextColor = isRangeKind ? '#78350f' : isClearKind ? 'hsl(var(--destructive-foreground))' : 'hsl(var(--primary-foreground))'
                    const accentRing = isRangeKind ? 'rgba(251,191,36,0.45)' : isClearKind ? 'hsl(var(--destructive) / 0.45)' : 'hsl(var(--primary) / 0.45)'
                    const highlightLabel = previewKind === 'rangeStart' ? 'Comment start point'
                      : previewKind === 'rangeEnd' ? 'Comment end point'
                      : previewKind === 'clear' ? 'Clear time range'
                      : 'PLAYHEAD POSITION'
                    return (
                    <>
                      {highlight && (
                        <div className="mb-1 flex flex-col items-center gap-1">
                          <div
                            className="rounded-md px-2.5 py-1 text-xs font-bold uppercase tracking-wide shadow-elevation-sm whitespace-nowrap"
                            style={{ backgroundColor: accentColor, color: accentTextColor }}
                          >
                            {highlightLabel}
                          </div>
                          {dragKind !== null && canShowTimelineHover && (
                            <div
                              className="rounded px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal whitespace-nowrap shadow-elevation-sm"
                              style={{
                                backgroundColor: isPrecisionDragging ? accentColor : 'hsl(var(--card))',
                                color: isPrecisionDragging ? accentTextColor : 'hsl(var(--muted-foreground))',
                                border: `1px solid ${isPrecisionDragging ? accentColor : 'hsl(var(--border))'}`,
                              }}
                            >
                              {isPrecisionDragging
                                ? 'Frame-by-frame — release mouse, then Shift'
                                : 'Hold Shift for precise positioning'}
                            </div>
                          )}
                        </div>
                      )}
                      <div
                        className="rounded-md overflow-hidden"
                        style={
                          highlight
                            ? {
                                width: displayW,
                                height: displayH,
                                border: `4px solid ${accentColor}`,
                                boxShadow: `0 0 0 2px ${accentRing}`,
                                backgroundColor: accentColor,
                              }
                            : {
                                width: displayW,
                                height: displayH,
                                border: '1px solid hsl(var(--border))',
                                backgroundColor: 'hsl(var(--card))',
                              }
                        }
                      >
                        {dragKind !== null && canShowTimelineHover && isPrecisionDragging && precisionFrameReady ? (
                          // Desktop precision (Shift) drag: paint the exact live video frame
                          // (kept in sync by the rAF effect) so the preview matches the main
                          // player. Default drags and touch fall back to the sprite below —
                          // they don't seek the video, and drawing a paused/rapidly-seeking
                          // video to canvas is unreliable on mobile anyway.
                          <canvas
                            ref={previewFrameCanvasRef}
                            width={displayW}
                            height={displayH}
                            style={{ width: displayW, height: displayH, display: 'block' }}
                          />
                        ) : (
                          <div
                            style={{
                              width: displayW,
                              height: displayH,
                              backgroundImage: `url(${timelineHover.spriteUrl})`,
                              backgroundSize: `${displayW * 10}px auto`,
                              backgroundPosition: `-${Math.round(timelineHover.x * scale)}px -${Math.round(timelineHover.y * scale)}px`,
                              backgroundRepeat: 'no-repeat',
                            }}
                          />
                        )}
                      </div>
                      <div
                        className={`mt-1 text-xs text-center tabular-nums ${highlight ? 'font-bold' : 'text-muted-foreground'}`}
                        style={highlight ? { color: accentColor } : undefined}
                      >
                        {formatTimestampForDuration(timelineHover.timeSeconds, effectiveDurationSeconds)}
                      </div>
                    </>
                    )
                  })()}
                </div>
              )}

              {/* Range-drag label fallback — shown while dragging an IN/OUT handle when
                  timeline sprites are unavailable (no scrub preview to attach the label
                  to). Renders the same amber-framed "Comment start/end point" badge + time
                  anchored to the handle, so the cue is identical with or without sprites. */}
              {(() => {
                const spritePreviewVisible =
                  timelineCues.length > 0 && timelineHover.visible && !!timelineHover.spriteUrl
                const dragKind = activeRangeDragHandle
                  ? (activeRangeDragHandle === 'start' ? 'rangeStart' : 'rangeEnd')
                  : isScrubbingPlayhead ? 'playhead' : null
                const previewKind = dragKind ?? hoveredTimelineTarget
                if (previewKind === null || spritePreviewVisible) return null
                const isRangeKind = previewKind === 'rangeStart' || previewKind === 'rangeEnd'
                const isClearKind = previewKind === 'clear'
                const rangeColor = '#fbbf24' // amber-400 — same as the range handles/fill
                const accentColor = isRangeKind ? rangeColor : isClearKind ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'
                const accentTextColor = isRangeKind ? '#78350f' : isClearKind ? 'hsl(var(--destructive-foreground))' : 'hsl(var(--primary-foreground))'
                const label = previewKind === 'rangeStart' ? 'Comment start point'
                  : previewKind === 'rangeEnd' ? 'Comment end point'
                  : previewKind === 'clear' ? 'Clear time range'
                  : 'PLAYHEAD POSITION'
                const anchorSeconds = previewKind === 'rangeStart' ? commentRangeStart
                  : previewKind === 'rangeEnd'
                    ? (dragKind === 'rangeEnd' || commentRangeHasExplicitSelectionRef.current ? commentRangeEnd : commentRangeStart)
                  : previewKind === 'clear' ? commentRangeEnd
                  : currentTimeSeconds
                return (
                  <div
                    className="absolute bottom-full mb-2 pointer-events-none z-20 flex flex-col items-center"
                    style={{
                      left: getLeftPxForSeconds(anchorSeconds, 180),
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div
                      className="flex flex-col items-stretch overflow-hidden rounded-md shadow-elevation-sm"
                      style={{ border: `3px solid ${accentColor}` }}
                    >
                      <div
                        className="px-2.5 py-1 text-xs font-bold uppercase tracking-wide whitespace-nowrap text-center"
                        style={{ backgroundColor: accentColor, color: accentTextColor }}
                      >
                        {label}
                      </div>
                      <div
                        className="bg-card px-2.5 py-1 text-sm font-bold tabular-nums text-center"
                        style={{ color: accentColor }}
                      >
                        {formatTimestampForDuration(anchorSeconds, effectiveDurationSeconds)}
                      </div>
                    </div>
                    {dragKind !== null && canShowTimelineHover && (
                      <div
                        className="mt-1 rounded px-2 py-0.5 text-[10px] font-medium whitespace-nowrap shadow-elevation-sm"
                        style={{
                          backgroundColor: isPrecisionDragging ? accentColor : 'hsl(var(--card))',
                          color: isPrecisionDragging ? accentTextColor : 'hsl(var(--muted-foreground))',
                          border: `1px solid ${isPrecisionDragging ? accentColor : 'hsl(var(--border))'}`,
                        }}
                      >
                        {isPrecisionDragging
                          ? 'Frame-by-frame — release mouse, then Shift'
                          : 'Hold Shift for precise positioning'}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>

            {/* Desktop: controls row below timeline — left / centre / right */}
            <div className="hidden lg:grid lg:grid-cols-[1fr_auto_1fr] items-center gap-[6px]">
              {/* Left: Play, Volume, Speed */}
              <div className="flex items-center gap-[6px]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>

                                <div
                  className="relative flex-shrink-0"
                  data-volume-control="true"
                  onMouseEnter={openVolumeSlider}
                  onMouseLeave={scheduleCloseVolumeSlider}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={toggleMute}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                    className="relative overflow-hidden w-14 px-0"
                  >
                    {Math.round(volume * 100) > 0 && Math.round(volume * 100) < 100 && (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 bg-primary/30"
                        style={{ width: `${Math.round(volume * 100)}%` }}
                      />
                    )}
                    <span className="relative z-10">
                      {isMuted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
                    </span>
                  </Button>

                  {showVolumeSlider && (
                    <div
                      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 rounded-lg border border-border bg-card p-2 shadow-elevation-sm"
                      onMouseEnter={openVolumeSlider}
                      onMouseLeave={scheduleCloseVolumeSlider}
                    >
                      <div className="h-28 w-10 flex items-center justify-center">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(volume * 100)}
                          onChange={(e) => {
                            const next = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0))
                            const nextVolume = next / 100
                            setVolume(nextVolume)
                            if (nextVolume > 0) {
                              setIsMuted(false)
                            }
                          }}
                          className="w-28 h-4 -rotate-90 accent-primary touch-none"
                          style={{ touchAction: 'none' }}
                          aria-label="Volume"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {!shouldHideSpeedControls && (
                  <>
                    {!isDesktopControlsNarrow && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleStepFrameBackward}
                        aria-label="Previous frame"
                        title="Previous frame"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDecreaseSpeed}
                      aria-label="Decrease playback speed"
                      className={cn(playbackSpeed !== 1.0 && playbackSpeed < 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <Rewind className="w-4 h-4" />
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleIncreaseSpeed}
                      aria-label="Increase playback speed"
                      className={cn(playbackSpeed !== 1.0 && playbackSpeed > 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <FastForward className="w-4 h-4" />
                    </Button>

                    {!isDesktopControlsNarrow && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleStepFrameForward}
                        aria-label="Next frame"
                        title="Next frame"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>

              {/* Centre: Time */}
              <div className="flex items-center justify-center gap-0.5">
                <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap text-center">
                  {formatTimestampDisplay(currentTimeSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)} /{' '}
                  {formatTimestampDisplay(effectiveDurationSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)}
                </div>
                {showTimeDisplayToggle && (
                <div className="relative time-display-toggle">
                  <button
                    type="button"
                    className="inline-flex items-center text-muted-foreground/60 hover:text-muted-foreground transition-colors p-0 bg-transparent border-0 cursor-pointer"
                    onClick={() => setShowTimeDisplayMenu((v) => !v)}
                    aria-label="Toggle time display format"
                    title="Switch between duration and timecode"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showTimeDisplayMenu && (
                    <div className="time-display-menu absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-md shadow-md py-1 z-50 min-w-[100px]">
                      <button
                        type="button"
                        className={cn(
                          'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                          timeDisplayMode === 'duration' && 'text-foreground font-medium',
                        )}
                        onClick={() => toggleTimeDisplayMode('duration')}
                      >
                        Duration
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                          timeDisplayMode === 'timecode' && 'text-foreground font-medium',
                          (!effectiveFps || effectiveFps <= 0) && 'text-muted-foreground/40 pointer-events-none',
                        )}
                        onClick={() => effectiveFps && effectiveFps > 0 && toggleTimeDisplayMode('timecode')}
                        title={!effectiveFps || effectiveFps <= 0 ? 'Timecode requires FPS metadata on this video' : undefined}
                      >
                        Timecode
                      </button>
                    </div>
                  )}
                </div>
                )}
              </div>

              {/* Right: Quality, Comments (fullscreen), Fullscreen, Download */}
              <div className="flex items-center gap-[6px] justify-end">
                {showQualitySelector && (
                  <div ref={desktopQualityControlsRef} className="relative flex-shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={hasOriginalOnly ? undefined : () => setShowQualityMenu((v) => !v)}
                      aria-label="Select quality"
                      className="text-xs px-2"
                    >
                      {qualityLabel}
                    </Button>

                    {showQualityMenu && !hasOriginalOnly && (
                      <div
                        className="absolute bottom-full right-0 mb-2 z-20 rounded-md border border-border bg-card shadow-elevation-sm py-1 min-w-[120px]"
                      >
                        <button
                          type="button"
                          className={cn(
                            'w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors',
                            selectedQuality === 'auto' && 'bg-accent font-medium'
                          )}
                          onClick={() => { setSelectedQuality('auto'); setShowQualityMenu(false) }}
                        >
                          Auto {selectedQuality === 'auto' && `(${autoResolvedQuality})`}
                        </button>
                        {qualityMenuOptions.map((q) =>
                          availableQualities.includes(q) ? (
                            <button
                              key={q}
                              type="button"
                              className={cn(
                                'w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors',
                                selectedQuality === q && 'bg-accent font-medium'
                              )}
                              onClick={() => { setSelectedQuality(q); setShowQualityMenu(false) }}
                            >
                              {q}
                            </button>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>
                )}

                {isInFullscreen && canShowTimelineHover && !disableCommentsUI && !disableFullscreenCommentsUI && !isGuest && (
                  <Button
                    type="button"
                    variant={isFullscreenChatOpen ? 'default' : 'outline'}
                    size="sm"
                    aria-label={isFullscreenChatOpen ? 'Hide comments' : 'Show comments'}
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('fullscreenChatSetOpen', {
                          detail: { open: !isFullscreenChatOpen },
                        })
                      )
                    }}
                  >
                    <MessageSquare className="w-4 h-4" />
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleFullscreen}
                  aria-label={isInFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                >
                  {isInFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </Button>

                {canShowApprovedDownload && approvedDownloadUrl && (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    aria-label="Download approved video"
                    title="Download approved video"
                    onClick={() => void handleApprovedDownloadClick()}
                  >
                    Download
                  </Button>
                )}
              </div>
            </div>

            {/* Mobile: row 2 controls (left: play/time, right: volume/speed/fullscreen) */}
            <div className="lg:hidden flex items-center gap-2 w-full min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  className="h-8 w-8"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>

                <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap truncate min-w-0 flex items-center gap-0.5">
                  <span>
                    {formatTimestampDisplay(currentTimeSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)} /{' '}
                    {formatTimestampDisplay(effectiveDurationSeconds, effectiveDurationSeconds, effectiveFps, timeDisplayMode)}
                  </span>
                  {showTimeDisplayToggle && (
                  <div className="relative time-display-toggle flex-shrink-0">
                    <button
                      type="button"
                      className="inline-flex items-center text-muted-foreground/60 hover:text-muted-foreground transition-colors p-0 bg-transparent border-0 cursor-pointer"
                      onClick={() => setShowTimeDisplayMenu((v) => !v)}
                      aria-label="Toggle time display format"
                      title="Switch between duration and timecode"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {showTimeDisplayMenu && (
                      <div className="time-display-menu absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-md shadow-md py-1 z-50 min-w-[100px]">
                        <button
                          type="button"
                          className={cn(
                            'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                            timeDisplayMode === 'duration' && 'text-foreground font-medium',
                          )}
                          onClick={() => toggleTimeDisplayMode('duration')}
                        >
                          Duration
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                            timeDisplayMode === 'timecode' && 'text-foreground font-medium',
                            (!effectiveFps || effectiveFps <= 0) && 'text-muted-foreground/40 pointer-events-none',
                          )}
                          onClick={() => effectiveFps && effectiveFps > 0 && toggleTimeDisplayMode('timecode')}
                          title={!effectiveFps || effectiveFps <= 0 ? 'Timecode requires FPS metadata on this video' : undefined}
                        >
                          Timecode
                        </button>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-1 flex-shrink-0 flex-wrap max-w-full">
                <div className="relative flex-shrink-0" data-volume-control="true">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={toggleMute}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                    className="relative overflow-hidden h-8 w-8"
                  >
                    {Math.round(volume * 100) > 0 && Math.round(volume * 100) < 100 && (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 bg-primary/30"
                        style={{ width: `${Math.round(volume * 100)}%` }}
                      />
                    )}
                    <span className="relative z-10">
                      {isMuted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
                    </span>
                  </Button>
                </div>

                {!shouldHideSpeedControls && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleDecreaseSpeed}
                      aria-label="Decrease playback speed"
                      className={cn('h-8 w-8', playbackSpeed < 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <Rewind className="w-4 h-4" />
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleIncreaseSpeed}
                      aria-label="Increase playback speed"
                      className={cn('h-8 w-8', playbackSpeed > 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <FastForward className="w-4 h-4" />
                    </Button>
                  </>
                )}

                {/* Mobile quality selector (cog icon, or "Original" label when no previews) */}
                {showQualitySelector && (
                  <div ref={mobileQualityControlsRef} className="relative flex-shrink-0">
                    {hasOriginalOnly ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label="Quality: Original"
                        className="text-xs px-2 h-8"
                      >
                        Original
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setShowQualityMenu((v) => !v)}
                        aria-label="Select quality"
                        className="h-8 w-8"
                      >
                        <Settings className="w-4 h-4" />
                      </Button>
                    )}

                    {showQualityMenu && !hasOriginalOnly && (
                      <div
                        className="absolute bottom-full right-0 mb-2 z-20 rounded-md border border-border bg-card shadow-elevation-sm py-1 min-w-[120px]"
                      >
                        <button
                          type="button"
                          className={cn(
                            'w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors',
                            selectedQuality === 'auto' && 'bg-accent font-medium'
                          )}
                          onClick={() => { setSelectedQuality('auto'); setShowQualityMenu(false) }}
                        >
                          Auto {selectedQuality === 'auto' && `(${autoResolvedQuality})`}
                        </button>
                        {qualityMenuOptions.map((q) =>
                          availableQualities.includes(q) ? (
                            <button
                              key={q}
                              type="button"
                              className={cn(
                                'w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors',
                                selectedQuality === q && 'bg-accent font-medium'
                              )}
                              onClick={() => { setSelectedQuality(q); setShowQualityMenu(false) }}
                            >
                              {q}
                            </button>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={toggleFullscreen}
                  aria-label={isInFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  className="h-8 w-8"
                >
                  {isInFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </Button>

                {canShowApprovedDownload && approvedDownloadUrl && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Download approved video"
                    title="Download approved video"
                    className="h-8 w-8"
                    onClick={() => void handleApprovedDownloadClick()}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard Shortcuts Dialog (triggered by CommentInput shortcut button) */}
      <Dialog open={showShortcutsDialog} onOpenChange={setShowShortcutsDialog}>
        <DialogContent
          portalContainer={playerContainerRef.current}
          className="bg-card border-border text-card-foreground max-w-[95vw] sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Video playback controls
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Play / Pause</span>
              <span className="flex items-center gap-1">
                <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Space</kbd>
                <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+Space</kbd>
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Skip Back / Forward 10s</span>
              <span className="flex items-center gap-1">
                <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">←</kbd>
                <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">→</kbd>
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Decrease Speed</span>
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+,</kbd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Increase Speed</span>
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+.</kbd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Reset Speed</span>
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+/</kbd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border">
              <span className="text-muted-foreground">Previous Frame</span>
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+J</kbd>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-muted-foreground">Next Frame</span>
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+L</kbd>
            </div>
            <p className="text-xs text-muted-foreground mt-4 pt-4 border-t border-border">
              Frame stepping pauses the video automatically. Speed range: 0.25x - 2.0x
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {canShowApprovedDownload && selectedVideo?.id ? (
        <VideoAssetDownloadModal
          videoId={String(selectedVideo.id)}
          videoName={approvedVideoName}
          versionLabel={approvedVideoVersionLabel}
          isOpen={showApprovedDownloadOptions}
          onClose={() => setShowApprovedDownloadOptions(false)}
          shareToken={shareToken}
          isAdmin={isAdmin}
        />
      ) : null}
    </div>
  )
}
