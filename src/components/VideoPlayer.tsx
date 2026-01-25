
'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import Image from 'next/image'
// Avoid importing Prisma runtime types in client components.
type Video = any
type ProjectStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'REVIEWED' | 'ON_HOLD' | 'SHARE_ONLY' | 'APPROVED' | 'CLOSED'
import { Button } from './ui/button'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, MessageSquare, Rewind, FastForward } from 'lucide-react'
import { cn, formatTimestamp } from '@/lib/utils'
import { timecodeToSeconds } from '@/lib/timecode'
import { InitialsAvatar } from '@/components/InitialsAvatar'
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

interface VideoPlayerProps {
  videos: Video[]
  projectId: string
  projectStatus: ProjectStatus
  defaultQuality?: '720p' | '1080p' // Default quality from settings
  onApprove?: () => void // Optional approval callback
  projectTitle?: string
  clientName?: string
  isPasswordProtected?: boolean
  watermarkEnabled?: boolean
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

  // Optional: when true, VideoPlayer will fill its parent height (non-fullscreen)
  // and allow the video area to flex/shrink to fit available space.
  fitToContainerHeight?: boolean
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
  watermarkEnabled = true,
  isAdmin = false, // Default to false (client view)
  isGuest = false, // Default to false (full client view)
  activeVideoName,
  initialSeekTime = null,
  initialVideoIndex = 0,
  shareToken = null,
  hideDownloadButton = false, // Default to false (show download button)
  commentsForTimeline = [],
  fitToContainerHeight = false,
}: VideoPlayerProps) {
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(initialVideoIndex)
  const [videoUrl, setVideoUrl] = useState<string>('')
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState<number>(0)
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState<number>(0)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const lastNonZeroVolumeRef = useRef(1)
  const volumeSliderCloseTimeoutRef = useRef<number | null>(null)
  const [videoAspectRatio, setVideoAspectRatio] = useState<number>(DEFAULT_ASPECT_RATIO)
  const [showPosterOverlay, setShowPosterOverlay] = useState(true)

  const [canShowTimelineHover, setCanShowTimelineHover] = useState(true)
  const [isMobileViewport, setIsMobileViewport] = useState(false)

  const playerContainerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false)
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false)

  const scrubBarRef = useRef<HTMLDivElement>(null)

  const scrubRafRef = useRef<number | null>(null)
  const pendingScrubClientXRef = useRef<number | null>(null)
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

  const scheduleScrubToClientX = (clientX: number) => {
    pendingScrubClientXRef.current = clientX
    if (scrubRafRef.current != null) return

    scrubRafRef.current = window.requestAnimationFrame(() => {
      scrubRafRef.current = null
      const x = pendingScrubClientXRef.current
      if (x == null) return

      if (videoRef.current) {
        const { time } = getTimeFromScrubEvent(x)
        try {
          videoRef.current.currentTime = time
        } catch {
          // ignore
        }
        currentTimeRef.current = time
        setCurrentTimeSeconds(time)
      }

      // Only show hover previews on devices that support hover.
      if (canShowTimelineHover) {
        updateHoverFromClientX(x)
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

  // If ANY video is approved, only show approved videos (for both admin and client)
  const hasAnyApprovedVideo = videos.some((v: any) => v.approved === true)
  const displayVideos = hasAnyApprovedVideo
    ? videos.filter((v: any) => v.approved === true)
    : videos

  // Safety check: ensure index is valid
  const safeIndex = Math.min(selectedVideoIndex, displayVideos.length - 1)
  const selectedVideo = displayVideos[safeIndex >= 0 ? safeIndex : 0]

  const effectiveDurationSeconds =
    durationSeconds || ((selectedVideo as any)?.duration as number | undefined) || 0

  const selectedVideoWidth = (selectedVideo as any)?.width as number | undefined
  const selectedVideoHeight = (selectedVideo as any)?.height as number | undefined

  const selectedVideoTimelineVttUrl = (selectedVideo as any)?.timelineVttUrl as string | null | undefined
  const selectedVideoTimelineSpriteUrl = (selectedVideo as any)?.timelineSpriteUrl as string | null | undefined
  const selectedVideoTimelinePreviewsReady = (selectedVideo as any)?.timelinePreviewsReady === true

  // When switching videos, the new <video> element will start paused.
  // If we were playing previously, React state can get "stuck" because the old
  // element unmounts without firing a pause event.
  useEffect(() => {
    setIsPlaying(false)
    setTimelineHover((prev) => ({ ...prev, visible: false }))
    setShowPosterOverlay(true)
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
    const duration = effectiveDurationSeconds
    if (!selectedVideo?.id || !duration || duration <= 0) {
      return [] as Array<{ id: string; seconds: number; isInternal: boolean; replyCount: number; displayColor?: string | null; authorName?: string | null; authorEmail?: string | null }>
    }

    const fps = (selectedVideo as any)?.fps || 24

    const markers: Array<{ id: string; seconds: number; isInternal: boolean; replyCount: number; displayColor?: string | null; authorName?: string | null; authorEmail?: string | null }> = []
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
        markers.push({
          id: String(comment.id),
          seconds: clamped,
          isInternal: Boolean((comment as any).isInternal),
          replyCount: Array.isArray((comment as any).replies) ? (comment as any).replies.length : 0,
          displayColor: (comment as any).displayColor || null,
          authorName: (comment as any).authorName || null,
          authorEmail: (comment as any).authorEmail || null,
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
  }, [commentsForTimeline, effectiveDurationSeconds, selectedVideo])

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
    }
  }, [selectedVideo?.id])

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideo?.id ?? null
  }, [selectedVideo?.id])

  useEffect(() => {
    if (!activeVideoName) return
    if (previousVideoNameRef.current && previousVideoNameRef.current !== activeVideoName) {
      setSelectedVideoIndex(0)
      setVideoUrl('')
      currentTimeRef.current = 0
    }
    previousVideoNameRef.current = activeVideoName
  }, [activeVideoName])

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
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    handleFullscreenChange()
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
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
  }, [canShowTimelineHover, isInFullscreen, isFullscreenChatOpen])

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
  const isVideoApproved = selectedVideo ? (selectedVideo as any).approved === true : false
  const isProjectApproved = projectStatus === 'APPROVED' || projectStatus === 'SHARE_ONLY'
  const approvedDownloadUrl = (selectedVideo as any)?.downloadUrl as string | null | undefined
  const canShowApprovedDownload =
    !hideDownloadButton && !isAdmin && !isGuest && isVideoApproved && Boolean(approvedDownloadUrl)

  // Speed controls should be hidden only when an approved video is selected in the client view.
  // This keeps the mobile controls row from getting too cramped once Download is shown.
  const shouldHideSpeedControls = !isAdmin && !isGuest && isVideoApproved

  // Load video URL with optimization
  useEffect(() => {
    async function loadVideoUrl() {
      try {
        // Safety check: ensure selectedVideo exists
        if (!selectedVideo) {
          return
        }

        // Use token-based URLs from the video object
        // These are generated by the share API with secure tokens
        // Respect the default quality setting from admin
        let url: string | undefined

        if (defaultQuality === '1080p') {
          // Prefer 1080p, fallback to 720p
          url = (selectedVideo as any).streamUrl1080p || (selectedVideo as any).streamUrl720p
        } else {
          // Prefer 720p, fallback to 1080p
          url = (selectedVideo as any).streamUrl720p || (selectedVideo as any).streamUrl1080p
        }

        if (url) {
          // Reset player state
          currentTimeRef.current = 0

          // Update video URL - this will trigger React to update the video element's src
          setVideoUrl(url)
        }
      } catch (error) {
        // Video load error - player will show error state
      }
    }

    loadVideoUrl()
  }, [selectedVideo, defaultQuality])

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

  const getTimeFromScrubEvent = (clientX: number) => {
    const el = scrubBarRef.current
    const duration = (videoRef.current?.duration || durationSeconds || (selectedVideo as any)?.duration || 0) as number
    if (!el || !duration || duration <= 0) return { time: 0, left: 0, width: 0 }
    const rect = el.getBoundingClientRect()
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

  const updateHoverFromTimeSeconds = (timeSeconds: number, minClampWidthPx?: number) => {
    const spriteBaseUrl = (selectedVideo as any)?.timelineSpriteUrl as string | null | undefined
    const duration = (videoRef.current?.duration || durationSeconds || (selectedVideo as any)?.duration || 0) as number
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

  const updateHoverFromClientX = (clientX: number) => {
    const spriteBaseUrl = (selectedVideo as any)?.timelineSpriteUrl as string | null | undefined
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

  // Handle initial seek from URL parameters (only once on mount)
  useEffect(() => {
    if (initialSeekTime !== null && videoRef.current && videoUrl && !hasInitiallySeenRef.current) {
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
  }, [initialSeekTime, videoUrl])


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
      const { timestamp, videoId, videoVersion } = e.detail

      // If the user is seeking to a timestamp, show actual video frames (not the poster overlay).
      setShowPosterOverlay(false)

      // If videoId is specified and different from current, try to switch to it
      if (videoId && videoId !== selectedVideo.id) {
        const targetVideoIndex = displayVideos.findIndex(v => v.id === videoId)
        if (targetVideoIndex !== -1) {
          setSelectedVideoIndex(targetVideoIndex)
          // Wait for video to load before seeking
          setTimeout(() => {
            if (videoRef.current) {
              videoRef.current.currentTime = timestamp
              currentTimeRef.current = timestamp
            }
          }, 500)
          return
        }
      }

      // Same video - just seek
      if (videoRef.current) {
        videoRef.current.currentTime = timestamp
        currentTimeRef.current = timestamp
      }
    }

    window.addEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    return () => {
      window.removeEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    }
  }, [selectedVideo.id, displayVideos])

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
          video.play()
        } else {
          video.pause()
        }
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
        if (!selectedVideo?.fps) return

        if (!video.paused) {
          video.pause()
        }

        const frameDuration = 1 / selectedVideo.fps
        video.currentTime = Math.max(0, video.currentTime - frameDuration)
        currentTimeRef.current = video.currentTime // Update ref for comment timecode
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
        return
      }

      // Ctrl+L: Go forward one frame
      if (e.ctrlKey && e.code === 'KeyL') {
        e.preventDefault()
        e.stopPropagation()
        if (!selectedVideo?.fps) return

        if (!video.paused) {
          video.pause()
        }

        const frameDuration = 1 / selectedVideo.fps
        const duration = Number.isFinite(video.duration) ? video.duration : undefined
        video.currentTime = duration
          ? Math.min(duration, video.currentTime + frameDuration)
          : video.currentTime + frameDuration
        currentTimeRef.current = video.currentTime // Update ref for comment timecode
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
        return
      }
    }

    // Use capture phase to intercept events before they reach other elements
    window.addEventListener('keydown', handleKeyboard, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyboard, { capture: true })
    }
  }, [selectedVideo])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const now = Date.now()
      // Throttle to update max every 200ms instead of 60 times per second
      if (now - lastTimeUpdateRef.current > 200) {
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
    const video = videoRef.current
    if (!video) return
    try {
      if (video.paused) {
        setShowPosterOverlay(false)
        await video.play()
      } else {
        video.pause()
      }
    } catch {
      // ignore
    }
  }

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
        fitToContainerHeight ? 'gap-4 min-h-0 h-full' : 'space-y-4 max-h-full'
      )}
    >
      <div
        ref={playerContainerRef}
        data-video-player-container="true"
        className={

          isInFullscreen
            ? 'fixed inset-0 z-50 bg-background flex flex-col p-3'
            : cn(
              'flex flex-col',
              fitToContainerHeight ? 'gap-4 min-h-0 h-full' : 'space-y-4'
            )
        }
      >
        {/* Video Player */}
        <div
          className={
            isInFullscreen
              ? 'relative bg-background overflow-hidden flex-1 min-h-0'
              : cn(
                'bg-background min-h-0 flex items-center justify-center',
                fitToContainerHeight ? 'relative overflow-hidden flex-1' : 'flex-shrink'
              )
          }
        >
          <div
            className={
              isInFullscreen
                ? 'relative w-full h-full'
                : cn(
                  'relative bg-background rounded-lg overflow-hidden',
                  fitToContainerHeight ? 'w-full h-full' : 'max-h-[70vh] max-h-[70dvh]'
                )
            }
            style={
              isInFullscreen
                ? undefined
                : fitToContainerHeight
                  ? undefined
                  : {
                    // Keep the correct aspect ratio but ensure portrait videos never exceed the viewport.
                    // If the video is taller than the available height, shrink the width to match.
                    width: `min(100%, calc(70vh * ${videoAspectRatio}))`,
                    aspectRatio: videoAspectRatio,
                  }
            }
          >
            {videoUrl ? (
              <video
                key={selectedVideo?.id}
                ref={videoRef}
                src={videoUrl}
                poster={(selectedVideo as any).thumbnailUrl || undefined}
                className="w-full h-full"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget

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
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onContextMenu={!isAdmin ? (e) => e.preventDefault() : undefined}
                crossOrigin="anonymous"
                playsInline
                preload={!isAdmin || hideDownloadButton ? 'auto' : 'metadata'}
                onClick={togglePlayPause}
                style={{
                  objectFit: 'contain',
                  backgroundColor: '#000',
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-card-foreground">
                Loading video...
              </div>
            )}

            {showPosterOverlay && (selectedVideo as any)?.thumbnailUrl ? (
              <Image
                alt="Video thumbnail"
                src={(selectedVideo as any).thumbnailUrl}
                fill
                unoptimized
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{
                  objectFit: 'contain',
                  backgroundColor: '#000',
                }}
              />
            ) : null}

            {/* Playback Speed Indicator - Show when speed is not 1.0x */}
            {playbackSpeed !== 1.0 && (
              <div className="absolute top-4 right-4 bg-black/80 text-white px-3 py-1.5 rounded-md text-sm font-medium pointer-events-none">
                {playbackSpeed.toFixed(2)}x
              </div>
            )}
          </div>
        </div>

        {/* Custom Controls + Timeline (enables hover thumbnails) */}
        <div className="relative flex-shrink-0">
          <div
            className="flex flex-col gap-2 pt-4 sm:pt-0 sm:flex-row sm:items-center sm:gap-3"
            onPointerDownCapture={handleControlsPointerDownCapture}
          >
            {/* Desktop/tablet: left controls */}
            <div className="hidden sm:flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </Button>

              <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {formatTimestampForDuration(currentTimeSeconds, effectiveDurationSeconds)} /{' '}
                {formatTimestampForDuration(effectiveDurationSeconds, effectiveDurationSeconds)}
              </div>
            </div>

            {/* Timeline (mobile row 1) */}
            <div className="flex-1 relative">
              <div
                ref={scrubBarRef}
                className="h-4 rounded-md bg-muted/40 border border-border cursor-pointer relative overflow-visible touch-none select-none"
                onPointerEnter={(e) => {
                  if (!canShowTimelineHover) return
                  updateHoverFromClientX(e.clientX)
                }}
                onPointerMove={(e) => {
                  if (isScrubbingRef.current) {
                    e.preventDefault()
                    scheduleScrubToClientX(e.clientX)
                    return
                  }

                  if (!canShowTimelineHover) return
                  updateHoverFromClientX(e.clientX)
                }}
                onPointerLeave={() => {
                  isScrubbingRef.current = false
                  setTimelineHover((prev) => ({ ...prev, visible: false }))
                  setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                }}
                onPointerDown={(e) => {
                  e.preventDefault()
                  // If the user is seeking, show actual video frames (not the poster overlay).
                  setShowPosterOverlay(false)
                  ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
                  isScrubbingRef.current = true
                  scheduleScrubToClientX(e.clientX)
                }}
                onPointerUp={(e) => {
                  try {
                    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                  } catch {}
                  isScrubbingRef.current = false
                }}
                onPointerCancel={(e) => {
                  try {
                    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                  } catch {}
                  isScrubbingRef.current = false
                  setTimelineHover((prev) => ({ ...prev, visible: false }))
                  setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                }}
                onClick={(e) => {
                  // If the user is seeking, show actual video frames (not the poster overlay).
                  setShowPosterOverlay(false)
                  if (videoRef.current) {
                    const { time } = getTimeFromScrubEvent(e.clientX)
                    videoRef.current.currentTime = time
                    currentTimeRef.current = time
                    setCurrentTimeSeconds(time)
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

                {/* Comment markers */}
                {timelineCommentMarkers.length > 0 && effectiveDurationSeconds > 0 && (
                  <div className="absolute inset-0 z-10">
                    {timelineCommentMarkers.map((m) => {
                      const leftPct = Math.min(100, Math.max(0, (m.seconds / effectiveDurationSeconds) * 100))
                      const avatarColor = m.displayColor || (m.isInternal ? '#0f172a' : '#64748b')
                      const avatarName = (m.authorName || '').trim() || (m.isInternal ? 'Admin' : 'Client')

                      const position = (() => {
                        // On mobile, clamp markers at the edges so the circle never renders off-screen.
                        if (!isMobileViewport) {
                          return { left: `${leftPct}%`, transform: 'translate(-50%, -50%)' }
                        }
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

                  {timelineCues.length > 0 && timelineHover.visible && timelineHover.spriteUrl && (
                    <>
                      <div
                        className="rounded-md border border-border overflow-hidden bg-card"
                        style={{ width: timelineHover.w, height: timelineHover.h }}
                      >
                        <div
                          style={{
                            width: timelineHover.w,
                            height: timelineHover.h,
                            backgroundImage: `url(${timelineHover.spriteUrl})`,
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: `-${timelineHover.x}px -${timelineHover.y}px`,
                          }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground text-center tabular-nums">
                        {formatTimestampForDuration(timelineHover.timeSeconds, effectiveDurationSeconds)}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Desktop/tablet: right controls */}
            <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
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
                    className={cn(playbackSpeed < 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                  >
                    <Rewind className="w-4 h-4" />
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleIncreaseSpeed}
                    aria-label="Increase playback speed"
                    className={cn(playbackSpeed > 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                  >
                    <FastForward className="w-4 h-4" />
                  </Button>
                </>
              )}

              {isInFullscreen && canShowTimelineHover && (
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
                <Button asChild type="button" variant="default" size="sm" aria-label="Download approved video" title="Download approved video">
                  <a href={approvedDownloadUrl} download>
                    Download
                  </a>
                </Button>
              )}
            </div>

            {/* Mobile: row 2 controls (left: play/time, right: volume/speed/fullscreen) */}
            <div className="sm:hidden flex items-center justify-between gap-2 w-full">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>

                <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                  {formatTimestampForDuration(currentTimeSeconds, effectiveDurationSeconds)} /{' '}
                  {formatTimestampForDuration(effectiveDurationSeconds, effectiveDurationSeconds)}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0" data-volume-control="true">
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
                </div>

                {!shouldHideSpeedControls && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDecreaseSpeed}
                      aria-label="Decrease playback speed"
                      className={cn(playbackSpeed < 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <Rewind className="w-4 h-4" />
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleIncreaseSpeed}
                      aria-label="Increase playback speed"
                      className={cn(playbackSpeed > 1.0 ? 'bg-primary/10 border-primary/50 text-primary' : '')}
                    >
                      <FastForward className="w-4 h-4" />
                    </Button>
                  </>
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
                  <Button asChild type="button" variant="default" size="sm" aria-label="Download approved video" title="Download approved video">
                    <a href={approvedDownloadUrl} download>
                      Download
                    </a>
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
              <kbd className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs font-mono">Ctrl+Space</kbd>
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
    </div>
  )
}