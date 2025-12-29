
'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { Video, ProjectStatus } from '@prisma/client'
import { Button } from './ui/button'
import { Download, Info, CheckCircle2, Play, Pause, Volume2, VolumeX, Maximize, Minimize, MessageSquare, Rewind, FastForward } from 'lucide-react'
import { cn, formatTimestamp, formatFileSize, formatDate } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { timecodeToSeconds } from '@/lib/timecode'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { VideoAssetDownloadModal } from './VideoAssetDownloadModal'
import { getAccessToken } from '@/lib/token-store'

interface VideoPlayerProps {
  videos: Video[]
  projectId: string
  projectStatus: ProjectStatus
  defaultQuality?: '720p' | '1080p' // Default quality from settings
  onApprove?: () => void // Optional approval callback
  projectTitle?: string
  projectDescription?: string
  clientName?: string
  isPasswordProtected?: boolean
  watermarkEnabled?: boolean
  isAdmin?: boolean // Admin users can see all versions (default: false for clients)
  isGuest?: boolean // Guest mode - limited view (videos only, no downloads)
  activeVideoName?: string // The video group name (for maintaining selection after reload)
  initialSeekTime?: number | null // Initial timestamp to seek to (from URL params)
  initialVideoIndex?: number // Initial video index to select (from URL params)
  allowAssetDownload?: boolean // Allow clients to download assets
  shareToken?: string | null
  hideDownloadButton?: boolean // Hide download button completely (for admin share view)

  // Optional: used to render comment markers along the timeline (share page).
  // Expected shape matches Comment (and optionally includes `replies`).
  commentsForTimeline?: any[]
}

export default function VideoPlayer({
  videos,
  projectId,
  projectStatus,
  defaultQuality = '720p',
  onApprove,
  projectTitle,
  projectDescription,
  clientName,
  isPasswordProtected,
  watermarkEnabled = true,
  isAdmin = false, // Default to false (client view)
  isGuest = false, // Default to false (full client view)
  activeVideoName,
  initialSeekTime = null,
  initialVideoIndex = 0,
  allowAssetDownload = true,
  shareToken = null,
  hideDownloadButton = false, // Default to false (show download button)
  commentsForTimeline = [],
}: VideoPlayerProps) {
  const router = useRouter()
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(initialVideoIndex)
  const [videoUrl, setVideoUrl] = useState<string>('')
  const [showInfoDialog, setShowInfoDialog] = useState(false)
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [hasAssets, setHasAssets] = useState(false)
  const [checkingAssets, setCheckingAssets] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState<number>(0)
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState<number>(0)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)

  const playerContainerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false)

  const scrubBarRef = useRef<HTMLDivElement>(null)
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

  const buildAuthHeaders = (shareTokenOverride?: string | null) => {
    const headers: Record<string, string> = {}
    const token = shareTokenOverride || (isAdmin ? getAccessToken() : null)
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

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

  // When switching videos, the new <video> element will start paused.
  // If we were playing previously, React state can get "stuck" because the old
  // element unmounts without firing a pause event.
  useEffect(() => {
    setIsPlaying(false)
    setTimelineHover((prev) => ({ ...prev, visible: false }))
  }, [selectedVideo?.id])

  const timelineCommentMarkers = useMemo(() => {
    const duration = effectiveDurationSeconds
    if (!selectedVideo?.id || !duration || duration <= 0) {
      return [] as Array<{ id: string; seconds: number; isInternal: boolean }>
    }

    const fps = (selectedVideo as any)?.fps || 24

    const flattened: any[] = []
    for (const c of commentsForTimeline || []) {
      flattened.push(c)
      if (Array.isArray((c as any)?.replies)) {
        flattened.push(...((c as any).replies as any[]))
      }
    }

    const markers: Array<{ id: string; seconds: number; isInternal: boolean }> = []
    for (const comment of flattened) {
      if (!comment) continue
      if (comment.videoId !== selectedVideo.id) continue
      if (!comment.timecode) continue
      if (!comment.id) continue
      try {
        const seconds = timecodeToSeconds(String(comment.timecode), fps)
        if (!Number.isFinite(seconds)) continue
        const clamped = Math.min(duration, Math.max(0, seconds))
        markers.push({
          id: String(comment.id),
          seconds: clamped,
          isInternal: Boolean((comment as any).isInternal),
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

  const handleOpenFeedback = () => {
    if (videoRef.current) {
      try {
        videoRef.current.pause()
      } catch {
        // ignore
      }
    }
    setIsPlaying(false)

    const el = document.getElementById('feedback-input')
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        ;(el as any).focus?.()
      } catch {
        // ignore
      }
    }
  }

  // Safety check: ensure selectedVideo exists before accessing properties
  const isVideoApproved = selectedVideo ? (selectedVideo as any).approved === true : false
  const isProjectApproved = projectStatus === 'APPROVED' || projectStatus === 'SHARE_ONLY'

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
      const vttUrl = (selectedVideo as any)?.timelineVttUrl as string | null | undefined
      const spriteUrl = (selectedVideo as any)?.timelineSpriteUrl as string | null | undefined
      const isReady = (selectedVideo as any)?.timelinePreviewsReady === true
      if (!vttUrl || !spriteUrl || !isReady) return

      try {
        const res = await fetch(vttUrl)
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
  }, [selectedVideo?.id])

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
      const handleLoadedMetadata = () => {
        if (videoRef.current && initialSeekTime !== null) {
          // Ensure timestamp is within video duration
          const duration = videoRef.current.duration
          const seekTime = Math.min(initialSeekTime, duration)

          videoRef.current.currentTime = seekTime
          currentTimeRef.current = seekTime
          // Don't auto-play - mobile browsers block this anyway, let user control playback

          // Mark that we've done the initial seek
          hasInitiallySeenRef.current = true
        }
      }

      // If metadata already loaded, seek immediately
      if (videoRef.current.readyState >= 1) {
        handleLoadedMetadata()
      } else {
        // Otherwise wait for metadata to load
        videoRef.current.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
      }

      return () => {
        videoRef.current?.removeEventListener('loadedmetadata', handleLoadedMetadata)
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
        lastTimeUpdateRef.current = now
      }
    }
  }

  const togglePlayPause = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (video.paused) {
        await video.play()
      } else {
        video.pause()
      }
    } catch {
      // ignore
    }
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

  const handleDownload = async () => {
    // Use secure token-based download URL
    const downloadUrl = (selectedVideo as any).downloadUrl
    if (!downloadUrl) {
      alert('Download is only available for approved projects')
      return
    }

    // Check if assets are available and asset downloads are allowed
    if (allowAssetDownload && !isGuest && !isAdmin) {
      setCheckingAssets(true)

      const authHeaders = buildAuthHeaders(shareToken)
      // Check if this video has assets (non-blocking)
      fetch(`/api/videos/${selectedVideo.id}/assets`, {
        headers: authHeaders,
      })
        .then(async (response) => {
          if (response.ok) {
            const data = await response.json()
            if (data.assets && data.assets.length > 0) {
              setHasAssets(true)
              setShowDownloadModal(true)
              setCheckingAssets(false)
              return true
            }
          }
          return false
        })
        .catch((err) => {
          // If checking fails, just proceed with direct download
          return false
        })
        .then((hasAssets) => {
          setCheckingAssets(false)
          if (!hasAssets) {
            // Direct download if no assets
            triggerDownload(downloadUrl)
          }
        })
      return
    }

    // Direct download if no assets or not allowed
    triggerDownload(downloadUrl)
  }

  const triggerDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = url
    link.download = ''
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleApprove = async () => {
    setLoading(true)

    const authHeaders = buildAuthHeaders(shareToken)
    // Approve project in background without blocking UI
    fetch(`/api/projects/${projectId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        selectedVideoId: selectedVideo.id,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData.error || 'Failed to approve project')
        }
        return response
      })
      .then(() => {
        // Store the current video group name in sessionStorage to restore after reload
        if (activeVideoName) {
          sessionStorage.setItem('approvedVideoName', activeVideoName)
        }

        // Call the optional callback if provided (for parent component updates)
        if (onApprove) {
          return onApprove()
        }
      })
      .catch((error) => {
        alert('Failed to approve project')
      })
      .finally(() => {
        setLoading(false)
      })
  }

  // Safety check: if no videos available, show message
  if (!selectedVideo || displayVideos.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No videos available
      </div>
    )
  }

  // Get display label - if video approved, show "Approved Version"
  const displayLabel = isVideoApproved ? 'Approved Version' : selectedVideo.versionLabel

  return (
    <div className="space-y-4 flex flex-col max-h-full">
      <div
        ref={playerContainerRef}
        className={
          isInFullscreen
            ? 'fixed inset-0 z-50 bg-background flex flex-col p-3'
            : 'flex flex-col space-y-4'
        }
      >
        {/* Video Player */}
        <div
          className={
            isInFullscreen
              ? 'relative bg-background overflow-hidden flex-1 min-h-0'
              : 'relative bg-background rounded-lg overflow-hidden aspect-video flex-shrink min-h-0'
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
              onLoadedMetadata={() => {
                if (!videoRef.current) return
                if (Number.isFinite(videoRef.current.duration)) {
                  setDurationSeconds(videoRef.current.duration)
                }
                setCurrentTimeSeconds(videoRef.current.currentTime || 0)

                // Ensure volume state is applied to new element
                videoRef.current.muted = isMuted
                videoRef.current.volume = Math.min(1, Math.max(0, volume))
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onContextMenu={!isAdmin ? (e) => e.preventDefault() : undefined}
              crossOrigin="anonymous"
              playsInline
              preload="metadata"
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

          {/* Playback Speed Indicator - Show when speed is not 1.0x */}
          {playbackSpeed !== 1.0 && (
            <div className="absolute top-4 right-4 bg-black/80 text-white px-3 py-1.5 rounded-md text-sm font-medium pointer-events-none">
              {playbackSpeed.toFixed(2)}x
            </div>
          )}
        </div>

        {/* Custom Controls + Timeline (enables hover thumbnails) */}
        <div className="relative flex-shrink-0">
          <div
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
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
                {formatTimestamp(currentTimeSeconds)} / {formatTimestamp(durationSeconds || (selectedVideo as any)?.duration || 0)}
              </div>
            </div>

            {/* Timeline (mobile row 1) */}
            <div className="flex-1 relative">
              <div
                ref={scrubBarRef}
                className="h-4 rounded-md bg-muted/40 border border-border cursor-pointer relative overflow-visible"
                onPointerEnter={(e) => updateHoverFromClientX(e.clientX)}
                onPointerMove={(e) => {
                  updateHoverFromClientX(e.clientX)
                  if (isScrubbingRef.current && videoRef.current) {
                    const { time } = getTimeFromScrubEvent(e.clientX)
                    videoRef.current.currentTime = time
                    currentTimeRef.current = time
                    setCurrentTimeSeconds(time)
                  }
                }}
                onPointerLeave={() => {
                  isScrubbingRef.current = false
                  setTimelineHover((prev) => ({ ...prev, visible: false }))
                  setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                }}
                onPointerDown={(e) => {
                  ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
                  isScrubbingRef.current = true
                  if (videoRef.current) {
                    const { time } = getTimeFromScrubEvent(e.clientX)
                    videoRef.current.currentTime = time
                    currentTimeRef.current = time
                    setCurrentTimeSeconds(time)
                  }
                }}
                onPointerUp={(e) => {
                  try {
                    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                  } catch {}
                  isScrubbingRef.current = false
                }}
                onClick={(e) => {
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

                {/* Comment markers (orange ticks) */}
                {timelineCommentMarkers.length > 0 && effectiveDurationSeconds > 0 && (
                  <div className="absolute inset-0 z-10">
                    {timelineCommentMarkers.map((m) => {
                      const leftPct = Math.min(100, Math.max(0, (m.seconds / effectiveDurationSeconds) * 100))
                      const markerColorClass = m.isInternal ? 'bg-green-500' : 'bg-orange-500'
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="absolute -top-3 h-8 w-4 bg-transparent focus:outline-none"
                          style={{ left: `${leftPct}%`, transform: 'translateX(-50%)' }}
                          title="Jump to comment"
                          aria-label="Jump to comment"
                          onPointerEnter={(e) => {
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
                            e.stopPropagation()
                            setTimelineCommentHover((prev) => ({ ...prev, visible: false, commentId: null }))
                          }}
                          onClick={(e) => {
                            e.stopPropagation()

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
                          <span className={`absolute left-1/2 top-0 h-8 w-0.5 -translate-x-1/2 ${markerColorClass}`} />
                          <span className={`absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full ${markerColorClass}`} />
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
                        {formatTimestamp(timelineHover.timeSeconds)}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Desktop/tablet: right controls */}
            <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
              <div className="relative flex-shrink-0" data-volume-control="true">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowVolumeSlider((s) => !s)}
                  aria-label={showVolumeSlider ? 'Hide volume' : 'Show volume'}
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
                    {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </span>
                </Button>

                {showVolumeSlider && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 rounded-lg border border-border bg-card p-2 shadow-elevation-sm">
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
                      className="w-28 h-4 -rotate-90 accent-primary"
                      aria-label="Volume"
                    />
                    </div>
                  </div>
                )}
              </div>

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

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggleFullscreen}
                aria-label={isInFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {isInFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </Button>
            </div>

            {/* Mobile: row 2 controls (left: play/time, right: volume/speed/chat/fullscreen) */}
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
                  {formatTimestamp(currentTimeSeconds)} / {formatTimestamp(durationSeconds || (selectedVideo as any)?.duration || 0)}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0" data-volume-control="true">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowVolumeSlider((s) => !s)}
                    aria-label={showVolumeSlider ? 'Hide volume' : 'Show volume'}
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
                      {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </span>
                  </Button>

                  {showVolumeSlider && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 rounded-lg border border-border bg-card p-2 shadow-elevation-sm">
                      <div className="h-24 w-10 flex items-center justify-center">
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
                          className="w-24 h-4 -rotate-90 accent-primary"
                          aria-label="Volume"
                        />
                      </div>
                    </div>
                  )}
                </div>

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

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleOpenFeedback}
                  aria-label="Open feedback"
                >
                  <MessageSquare className="w-4 h-4" />
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleFullscreen}
                  aria-label={isInFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                >
                  {isInFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Version Selector - Only show if there are multiple versions to choose from */}
      {displayVideos.length > 1 && (
        <div className="flex gap-3 overflow-x-auto py-2 flex-shrink-0">
          {displayVideos.map((video, index) => {
            const videoApproved = (video as any).approved === true
            return (
              <Button
                key={video.id}
                onClick={() => setSelectedVideoIndex(index)}
                variant={selectedVideoIndex === index ? 'default' : 'outline'}
                className="whitespace-nowrap relative"
              >
                {videoApproved && (
                  <CheckCircle2 className="w-4 h-4 mr-2 text-success" />
                )}
                {videoApproved ? 'Approved Version' : video.versionLabel}
              </Button>
            )
          })}
        </div>
      )}

      {/* Video & Project Information */}
      <div className={`rounded-lg p-4 text-card-foreground flex-shrink-0 ${!isVideoApproved ? 'bg-accent/50 border-2 border-primary/20' : 'bg-card border border-border'}`}>
        <Dialog open={showShortcutsDialog} onOpenChange={setShowShortcutsDialog}>
          <DialogContent className="bg-card border-border text-card-foreground max-w-[95vw] sm:max-w-md">
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

        {/* Header: Version + Action Buttons, then Filename below */}
        <div className="space-y-3 mb-3 pb-3 border-b border-border">
          {/* Top row: Approved Badge + Version Label + Action Buttons */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isVideoApproved && (
                <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
              )}
              <span className="text-base font-semibold text-foreground whitespace-nowrap">{displayLabel}</span>
            </div>
            <div className="flex gap-2 flex-shrink-0">
            {/* Info Dialog Button - Hide in guest mode */}
            {!isGuest && (
              <Dialog open={showInfoDialog} onOpenChange={setShowInfoDialog}>
                <Button variant="outline" size="sm" onClick={() => setShowInfoDialog(true)}>
                  <Info className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">Info</span>
                </Button>
                <DialogContent className="bg-card border-border text-card-foreground max-w-[95vw] sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Video Information</DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                      Detailed metadata for the original video
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3 text-xs sm:text-sm">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Filename:</span>
                      <span className="font-medium break-all text-xs sm:text-sm">{selectedVideo.originalFileName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Resolution:</span>
                      <span className="font-medium">{selectedVideo.width}x{selectedVideo.height}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Codec:</span>
                      <span className="font-medium">{selectedVideo.codec || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Duration:</span>
                      <span className="font-medium">{formatTimestamp(selectedVideo.duration)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">FPS:</span>
                      <span className="font-medium">{selectedVideo.fps ? selectedVideo.fps.toFixed(2) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">File Size:</span>
                      <span className="font-medium">{formatFileSize(Number(selectedVideo.originalFileSize))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Upload Date:</span>
                      <span className="font-medium">{formatDate(selectedVideo.createdAt)}</span>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="text-muted-foreground">Status:</span>
                      <span className="font-medium break-words">
                        {isVideoApproved
                          ? 'Approved - Original Quality'
                          : `Downscaled Preview (${defaultQuality})${watermarkEnabled ? ' with Watermark' : ''}`
                        }
                      </span>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}

            {/* Download Button - Only show when video is approved and not in guest mode */}
            {isVideoApproved && !isGuest && !hideDownloadButton && (
              <Button onClick={handleDownload} variant="default" size="sm">
                <Download className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Download</span>
              </Button>
            )}
            </div>
          </div>

          {/* Bottom row: Filename */}
          <div>
            <h3 className="text-lg font-bold text-foreground break-words">{(selectedVideo as any).name}</h3>
          </div>
        </div>

        {/* Information Grid - Compact 2 column layout */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {/* Project */}
          {projectTitle && (
            <div className="col-span-2">
              <span className="text-xs text-muted-foreground">Project:</span>
              <span className="ml-2 font-medium text-foreground">{projectTitle}</span>
            </div>
          )}

          {/* For (Client) */}
          {clientName && (
            <div className="col-span-2">
              <span className="text-xs text-muted-foreground">For:</span>
              <span className="ml-2 font-medium text-foreground">{isPasswordProtected ? clientName : 'Client'}</span>
            </div>
          )}

          {/* Description */}
          {projectDescription && (
            <div className="col-span-2">
              <span className="text-xs text-muted-foreground">Description:</span>
              <span className="ml-2 text-foreground whitespace-pre-wrap">{projectDescription}</span>
            </div>
          )}
        </div>

        {/* Note & Approval Section (only if video not approved and approval is allowed) */}
        {!isVideoApproved && onApprove && (
          <>
            <div className="text-xs text-muted-foreground pt-3 mt-3 border-t border-border">
              <span className="font-medium text-foreground">Note:</span> This is a downscaled preview{watermarkEnabled && ' with watermark'}. Original quality will be available for download once approved.
            </div>

            <div className="pt-2 mt-2">
              {!showApprovalConfirm ? (
                <Button
                  onClick={() => setShowApprovalConfirm(true)}
                  variant="success"
                  size="default"
                  className="w-full"
                >
                  Approve this video as final
                </Button>
              ) : (
                <div className="space-y-4 bg-primary/10 border-2 border-primary rounded-lg p-4">
                  <div className="text-center space-y-2">
                    <p className="text-base text-foreground font-bold">
                      Approve this video?
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Video: <span className="font-semibold text-foreground">{(selectedVideo as any).name}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Version: <span className="font-semibold text-foreground">{selectedVideo.versionLabel}</span>
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handleApprove}
                      disabled={loading}
                      variant="success"
                      size="default"
                      className="flex-1 font-semibold"
                    >
                      {loading ? 'Approving...' : 'Yes, Approve This Video'}
                    </Button>
                    <Button
                      onClick={() => setShowApprovalConfirm(false)}
                      variant="outline"
                      disabled={loading}
                      size="default"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Approved Status */}
        {isVideoApproved && (
          <div className="flex items-center gap-2 text-sm text-success pt-3 mt-3 border-t border-border">
            <CheckCircle2 className="w-4 h-4" />
            <span className="font-medium">
              {selectedVideo.versionLabel} approved - Download available
            </span>
          </div>
        )}
      </div>

      {/* Download Modal - Only for clients with assets */}
      {showDownloadModal && hasAssets && (
        <VideoAssetDownloadModal
          videoId={selectedVideo.id}
          videoName={(selectedVideo as any).name || ''}
          versionLabel={selectedVideo.versionLabel}
          isOpen={showDownloadModal}
          onClose={() => setShowDownloadModal(false)}
          shareToken={shareToken}
          isAdmin={isAdmin}
        />
      )}
    </div>
  )
}