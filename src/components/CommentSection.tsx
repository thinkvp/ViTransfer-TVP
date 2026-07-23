'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Video } from '@/types/video'
// Avoid importing Prisma runtime types in client components.
type Comment = any
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, FileClock, History, Info, Lock, MessageCircle, Share2, X } from 'lucide-react'
import MessageBubble from './MessageBubble'
import CommentInput from './CommentInput'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { useTimeDisplayMode } from '@/hooks/useTimeDisplayMode'
import { formatDate, formatTimestamp, formatDateTime, formatFileSize } from '@/lib/utils'
import { timecodeToSeconds } from '@/lib/timecode'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface CommentSectionProps {
  projectId: string
  projectSlug?: string
  comments: CommentWithReplies[]
  clientName: string
  clientEmail?: string
  isApproved: boolean
  restrictToLatestVersion?: boolean
  useFullTimecode?: boolean
  videos?: Video[]
  isAdminView?: boolean
  canAdminDeleteComments?: boolean
  companyName?: string // Studio company name
  clientCompanyName?: string | null // Client company name
  smtpConfigured?: boolean
  isPasswordProtected?: boolean
  adminUser?: any
  recipients?: Array<{ id: string; name: string | null; email?: string | null }>
  shareToken?: string | null
  showShortcutsButton?: boolean
  allowClientDeleteComments?: boolean
  allowClientUploadFiles?: boolean
  allowCommentFileUpload?: boolean
  hideInput?: boolean
  showVideoActions?: boolean
  showVideoNotes?: boolean
  showApproveButton?: boolean
  largeAvatars?: boolean
  cardClassName?: string
  hideVideoTitle?: boolean
}

type CommentManagement = ReturnType<typeof useCommentManagement>

function parseVideoFileSize(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}


export function CommentSectionView({
  projectId,
  projectSlug,
  comments: initialComments,
  clientName,
  clientEmail,
  isApproved,
  restrictToLatestVersion = false,
  useFullTimecode = false,
  videos = [],
  isAdminView = false,
  canAdminDeleteComments = true,
  companyName = 'Studio',
  clientCompanyName = null,
  smtpConfigured = false,
  isPasswordProtected = false,
  adminUser = null,
  recipients = [],
  shareToken = null,
  showShortcutsButton = false,
  allowClientDeleteComments = false,
  allowClientUploadFiles = false,
  allowCommentFileUpload = allowClientUploadFiles || isAdminView,
  hideInput = false,
  showVideoActions = true,
  showVideoNotes = true,
  showApproveButton = true,
  largeAvatars = false,
  cardClassName,
  hideVideoTitle = false,
  management,
}: CommentSectionProps & { management: CommentManagement }) {
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false)
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false)
  const [fullscreenChatPortalTarget, setFullscreenChatPortalTarget] = useState<HTMLElement | null>(null)

  const [origin, setOrigin] = useState<string | null>(null)

  const router = useRouter()
  const {
    comments,
    newComment,
    selectedTimestamp,
    selectedEndTimestamp,
    selectedVideoId,
    selectedVideoFps,
    loading,
    uploadProgress,
    uploadStatusText,
    replyingToCommentId,
    replyingToComment,
    authorName,
    handleCommentChange,
    handleSubmitComment,
    handleReply,
    handleCancelReply,
    handleClearTimestamp,
    handleDeleteComment,
    handleEditComment,
    pendingDeleteCommentId,
    setPendingDeleteCommentId,
    confirmDeleteComment,
    setAuthorName,
    attachedFiles,
    onFileSelect,
    onRemoveFile,
    clientUploadQuota,
    refreshClientUploadQuota,
  } = management

  // Feedback "mark done" state (admin share page only). Optimistic per-comment overrides
  // keyed by comment id; falls back to the server value when absent.
  const [resolvedOverrides, setResolvedOverrides] = useState<Record<string, string | null>>({})
  const effectiveResolvedAt = useCallback(
    (c: any): string | null => (c && c.id in resolvedOverrides ? resolvedOverrides[c.id] : (c?.resolvedAt ?? null)),
    [resolvedOverrides]
  )
  const handleToggleResolved = useCallback(
    async (commentId: string, currentlyResolved: boolean) => {
      const nextResolved = !currentlyResolved
      setResolvedOverrides((prev) => ({ ...prev, [commentId]: nextResolved ? new Date().toISOString() : null }))
      try {
        const res = await apiFetch('/api/admin/feedback/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved: nextResolved, projectId, commentId }),
        })
        if (!res.ok) throw new Error('Failed')
      } catch {
        // Revert to the server value on failure.
        setResolvedOverrides((prev) => {
          const next = { ...prev }
          delete next[commentId]
          return next
        })
        toast.error('Could not update feedback status')
      }
    },
    [projectId]
  )

  const syncFullscreenStateFromDom = useCallback(() => {
    if (typeof window === 'undefined') return

    const el = document.querySelector('[data-video-player-container="true"]') as HTMLElement | null
    if (!el) {
      setIsVideoFullscreen(false)
      setFullscreenChatPortalTarget(null)
      return
    }

    // For pseudo-fullscreen we rely on the player adding the `fixed` class.
    // For true fullscreen we can also check fullscreenElement.
    const isFullscreenLike = document.fullscreenElement === el || el.classList.contains('fixed')
    setIsVideoFullscreen(isFullscreenLike)
                          setGuestLinkUrl(null)
                          setGuestLinkExpiresAt(null)
    setFullscreenChatPortalTarget(isFullscreenLike ? el : null)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const onFullscreenStateChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ isInFullscreen?: boolean }>).detail
      const next = Boolean(detail?.isInFullscreen)
      setIsVideoFullscreen(next)
      if (!next) setIsFullscreenChatOpen(false)

      // Keep portal target in sync (covers pseudo-fullscreen too).
      syncFullscreenStateFromDom()
    }

    const onSetOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail
      if (typeof detail?.open !== 'boolean') return
      setIsFullscreenChatOpen(detail.open)

      // If we're already in fullscreen when CommentSection mounts, we can miss the
      // initial fullscreen state event. Sync from DOM when opening.
      if (detail.open) {
        syncFullscreenStateFromDom()
      }
    }

    window.addEventListener('videoFullscreenStateChanged', onFullscreenStateChanged)
    window.addEventListener('fullscreenChatSetOpen', onSetOpen)

    // Initial sync in case we're already fullscreen when this mounts.
    syncFullscreenStateFromDom()

    return () => {
      window.removeEventListener('videoFullscreenStateChanged', onFullscreenStateChanged)
      window.removeEventListener('fullscreenChatSetOpen', onSetOpen)
    }
  }, [syncFullscreenStateFromDom])

  // Auto-scroll to latest comment (like messaging apps)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [localComments, setLocalComments] = useState<CommentWithReplies[]>(initialComments)

  const [commentSortMode, setCommentSortMode] = useState<'timecode' | 'date'>('timecode')
  // Follow the shared Time/Timecode toggle so flipping it anywhere on the share
  // page (e.g. the comment time editor) reformats the comment list too.
  const { timeDisplayMode } = useTimeDisplayMode(useFullTimecode)
  const showFrames = timeDisplayMode === 'timecode'
  const [showVideoInfo, setShowVideoInfo] = useState(false)

  // Open video info dialog via custom event (triggered from page-level header)
  useEffect(() => {
    const handler = () => setShowVideoInfo(true)
    window.addEventListener('openVideoInfoDialog', handler)
    return () => window.removeEventListener('openVideoInfoDialog', handler)
  }, [])

  // Open guest link dialog via custom event (triggered from page-level header)
  const openGuestLinkDialog = useCallback(() => {
    setGuestLinkDialogOpen(true)
    setGuestLinkUrl(null)
    setGuestLinkExpiresAt(null)
    setGuestLinkError(null)
    setGuestLinkCheckedExisting(false)
    setGuestLinkMissing(false)
    setGuestLinkCopied(false)
  }, [])

  useEffect(() => {
    window.addEventListener('openGuestLinkDialog', openGuestLinkDialog)
    return () => window.removeEventListener('openGuestLinkDialog', openGuestLinkDialog)
  }, [openGuestLinkDialog])
  const [guestLinkDialogOpen, setGuestLinkDialogOpen] = useState(false)
  const [guestLinkGenerating, setGuestLinkGenerating] = useState(false)
  const [guestLinkRefreshing, setGuestLinkRefreshing] = useState(false)
  const [guestLinkLoadingExisting, setGuestLinkLoadingExisting] = useState(false)
  const [guestLinkCheckedExisting, setGuestLinkCheckedExisting] = useState(false)
  const [guestLinkMissing, setGuestLinkMissing] = useState(false)
  const [guestLinkError, setGuestLinkError] = useState<string | null>(null)
  const [guestLinkUrl, setGuestLinkUrl] = useState<string | null>(null)
  const [guestLinkExpiresAt, setGuestLinkExpiresAt] = useState<string | null>(null)
  const [guestLinkCopied, setGuestLinkCopied] = useState(false)
  const [guestLinkExpired, setGuestLinkExpired] = useState(false)
  useEffect(() => {
    if (!guestLinkExpiresAt) {
      setGuestLinkExpired(false)
      return
    }
    const expiresAtMs = new Date(guestLinkExpiresAt).getTime()
    setGuestLinkExpired(Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now())
  }, [guestLinkExpiresAt])
  const [showApproveConfirm, setShowApproveConfirm] = useState(false)
  const [approving, setApproving] = useState(false)
  const approvingRef = useRef(false)
  const [showRequestNextConfirm, setShowRequestNextConfirm] = useState(false)
  const [requestingNext, setRequestingNext] = useState(false)
  const requestingNextRef = useRef(false)

  const [versionNotesOpen, setVersionNotesOpen] = useState(true)

  const [exportingSrt, setExportingSrt] = useState(false)
  // Optimistic local flag: remember which video was just approved until server data propagates.
  const [localApprovedVideoId, setLocalApprovedVideoId] = useState<string | null>(null)
  // Optimistic local flag: remember which video just had its next version requested
  // (the SSE echo guard suppresses the requester's own refetch for a moment).
  const [localRevisionRequestedVideoId, setLocalRevisionRequestedVideoId] = useState<string | null>(null)
  const pendingScrollRef = useRef<{ commentId: string; parentId: string | null } | null>(null)
  const pendingScrollAttemptsRef = useRef(0)
  const commentPlaybackUrlCacheRef = useRef<Map<string, string>>(new Map())

  const canClientDelete = allowClientDeleteComments && !isAdminView
  const canAdminDelete = isAdminView && canAdminDeleteComments

  // Own-comment check for inline editing. Admins match by userId; clients match by the
  // name they entered on the share page (honor-system by design — names are not verified).
  const normalizedViewerName = (authorName || '').trim().toLowerCase()
  const isOwnComment = (c: any): boolean => {
    if (isAdminView) {
      return Boolean(c?.userId && adminUser?.id && c.userId === adminUser.id)
    }
    if (!normalizedViewerName) return false
    return String(c?.authorName || '').trim().toLowerCase() === normalizedViewerName
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    setOrigin(window.location.origin)
  }, [])

  const postGuestVideoLink = async (action: 'generate' | 'refreshExpiry') => {
    const response = isAdminView
      ? await apiFetch('/api/guest-video-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, projectId, videoId: selectedVideoId }),
        })
      : await fetch('/api/guest-video-links', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
          },
          body: JSON.stringify({ action, projectId, videoId: selectedVideoId }),
        })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(String((data as any)?.error || 'Failed to update link'))
    }

    const urlPath = String((data as any)?.urlPath || '')
    const expiresAt = (data as any)?.expiresAt ? String((data as any).expiresAt) : null
    if (!urlPath) {
      throw new Error('Failed to update link')
    }

    const absolute = new URL(urlPath, window.location.origin).toString()
    setGuestLinkUrl(absolute)
    setGuestLinkExpiresAt(expiresAt)
  }

  const generateGuestVideoLink = async () => {
    if (!projectId || !selectedVideoId) return

    setGuestLinkGenerating(true)
    setGuestLinkError(null)
    setGuestLinkCopied(false)

    try {
      await postGuestVideoLink('generate')
    } catch (e: any) {
      setGuestLinkError(e?.message || 'Failed to generate link')
    } finally {
      setGuestLinkGenerating(false)
    }
  }

  const refreshGuestVideoLinkExpiry = async () => {
    if (!projectId || !selectedVideoId) return
    if (!guestLinkUrl) return

    setGuestLinkRefreshing(true)
    setGuestLinkError(null)
    setGuestLinkCopied(false)

    try {
      await postGuestVideoLink('refreshExpiry')
    } catch (e: any) {
      setGuestLinkError(e?.message || 'Failed to refresh expiry')
    } finally {
      setGuestLinkRefreshing(false)
    }
  }

  const loadExistingGuestVideoLink = useCallback(async () => {
    if (!guestLinkDialogOpen) return
    if (!projectId || !selectedVideoId) return

    setGuestLinkLoadingExisting(true)
    setGuestLinkUrl(null)
    setGuestLinkExpiresAt(null)
    setGuestLinkError(null)
    setGuestLinkCheckedExisting(false)
    setGuestLinkMissing(false)
    try {
      const url = `/api/guest-video-links?projectId=${encodeURIComponent(projectId)}&videoId=${encodeURIComponent(selectedVideoId)}`
      const response = isAdminView
        ? await apiFetch(url, { cache: 'no-store' })
        : await fetch(url, {
            cache: 'no-store',
            headers: {
              ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
            },
          })

      if (response.status === 404) {
        // No existing link for this version.
        setGuestLinkCheckedExisting(true)
        setGuestLinkMissing(true)
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setGuestLinkCheckedExisting(true)
        setGuestLinkMissing(true)
        return
      }

      const urlPath = String((data as any)?.urlPath || '')
      const expiresAt = (data as any)?.expiresAt ? String((data as any).expiresAt) : null
      if (!urlPath) return

      const absolute = new URL(urlPath, window.location.origin).toString()
      setGuestLinkUrl(absolute)
      setGuestLinkExpiresAt(expiresAt)
      setGuestLinkCheckedExisting(true)
      setGuestLinkMissing(false)
    } finally {
      setGuestLinkLoadingExisting(false)
    }
  }, [guestLinkDialogOpen, projectId, selectedVideoId, isAdminView, shareToken])

  useEffect(() => {
    if (!guestLinkDialogOpen) return
    void loadExistingGuestVideoLink()
  }, [guestLinkDialogOpen, loadExistingGuestVideoLink])

  const copyGuestLink = async () => {
    if (!guestLinkUrl) return
    try {
      await navigator.clipboard.writeText(guestLinkUrl)
      setGuestLinkCopied(true)
      setTimeout(() => setGuestLinkCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const handleDownloadCommentFile = async (commentId: string, fileId: string, fileName: string) => {
    try {
      const url = `/api/comments/${commentId}/files/${fileId}`
      const response = isAdminView
        ? await apiFetch(url)
        : shareToken
          ? await fetch(url, { headers: { Authorization: `Bearer ${shareToken}` } })
          : await fetch(url)

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to download file')
      }

      // If the route redirected to an external S3/R2 presigned URL, navigate there directly
      // so the browser uses its native download manager (with progress indicator).
      const isS3Redirect = response.url && !response.url.startsWith(window.location.origin) && !response.url.startsWith('/')
      if (isS3Redirect) {
        void response.body?.cancel()
        const a = document.createElement('a')
        a.href = response.url
        document.body.appendChild(a)
        a.click()
        a.remove()
        return
      }

      // Local storage fallback: buffer via blob.
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      toast.error(`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const resolveCommentFilePlaybackUrl = async (commentId: string, fileId: string): Promise<string | null> => {
    const cacheKey = `${commentId}:${fileId}`
    const cached = commentPlaybackUrlCacheRef.current.get(cacheKey)
    if (cached) return cached

    const url = `/api/comments/${commentId}/files/${fileId}`
    const response = isAdminView
      ? await apiFetch(url)
      : shareToken
        ? await fetch(url, { headers: { Authorization: `Bearer ${shareToken}` } })
        : await fetch(url)

    if (!response.ok) {
      return null
    }

    const isS3Redirect = response.url && !response.url.startsWith(window.location.origin) && !response.url.startsWith('/')
    if (isS3Redirect) {
      commentPlaybackUrlCacheRef.current.set(cacheKey, response.url)
      return response.url
    }

    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    commentPlaybackUrlCacheRef.current.set(cacheKey, objectUrl)
    return objectUrl
  }

  useEffect(() => {
    const playbackUrlCache = commentPlaybackUrlCacheRef.current
    return () => {
      for (const url of playbackUrlCache.values()) {
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      }
      playbackUrlCache.clear()
    }
  }, [])

  const parseDownloadFilename = (contentDisposition: string | null): string | null => {
    if (!contentDisposition) return null

    // Handle RFC5987: filename*=UTF-8''...
    const rfc5987 = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (rfc5987?.[1]) {
      try {
        return decodeURIComponent(rfc5987[1].replace(/(^\"|\"$)/g, ''))
      } catch {
        return rfc5987[1].replace(/(^\"|\"$)/g, '')
      }
    }

    const simple = contentDisposition.match(/filename=\"?([^\";]+)\"?/i)
    return simple?.[1] || null
  }

  const handleExportCommentsSrt = async () => {
    try {
      if (!selectedVideoId) {
        toast.error('No video selected to export comments for.')
        return
      }

      setExportingSrt(true)

      const url = `/api/comments/export-srt?projectId=${encodeURIComponent(projectId)}&videoId=${encodeURIComponent(selectedVideoId)}`
      const response = await apiFetch(url)

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to export comments')
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = objectUrl
      a.download = parseDownloadFilename(response.headers.get('content-disposition')) || 'comments.srt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      toast.error(`Failed to export comments: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setExportingSrt(false)
    }
  }

  // Fetch comments function (only used for event-triggered updates)
  const fetchComments = useCallback(async () => {
    try {
      const response = isAdminView
        ? await apiFetch(`/api/comments?projectId=${projectId}`)
        : shareToken
          ? await fetch(`/api/comments?projectId=${projectId}`, {
              headers: { Authorization: `Bearer ${shareToken}` },
            })
          : null

      if (!response) return

      if (response.ok) {
        const freshComments = await response.json()
        setLocalComments(freshComments)
      }
    } catch {
      // Silent fail - keep showing existing comments
    }
  }, [isAdminView, projectId, shareToken])

  // Initialize localComments only (no polling - hook handles optimistic updates)
  useEffect(() => {
    setLocalComments(initialComments)
  }, [initialComments])

  // Listen for immediate comment updates (delete, approve, post, etc.)
  useEffect(() => {
    const handleCommentPosted = (e: CustomEvent) => {
      const newCommentId = e.detail?.newCommentId as string | undefined
      const parentId = (e.detail?.parentId as string | null | undefined) ?? null
      if (newCommentId) {
        pendingScrollRef.current = { commentId: newCommentId, parentId }
        pendingScrollAttemptsRef.current = 0
      }

      // Use the comments data from the event if available, otherwise refetch
      if (e.detail?.comments) {
        setLocalComments(e.detail.comments)
      } else {
        fetchComments()
      }
    }

    const handleCommentUpdate = () => {
      fetchComments()
    }

    window.addEventListener('commentDeleted', handleCommentUpdate)
    window.addEventListener('commentPosted', handleCommentPosted as EventListener)
    window.addEventListener('videoApprovalChanged', handleCommentUpdate)

    return () => {
      window.removeEventListener('commentDeleted', handleCommentUpdate)
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
      window.removeEventListener('videoApprovalChanged', handleCommentUpdate)
    }
  }, [fetchComments])

  // Get latest video version
  const latestVideoVersion = videos.length > 0
    ? Math.max(...videos.map(v => v.version))
    : null

  // Check if currently selected video is approved
  const currentVideo = videos.find(v => v.id === selectedVideoId)
  const hasLocallyApprovedVideoInGroup = Boolean(
    localApprovedVideoId && videos.some(v => v.id === localApprovedVideoId)
  )
  const isCurrentVideoApproved = currentVideo
    ? currentVideo.approved === true || currentVideo.id === localApprovedVideoId
    : false
  // Check if ANY video in the group is approved (for admin view with multiple versions)
  const hasAnyApprovedVideo = videos.some(v => v.approved === true) || hasLocallyApprovedVideoInGroup
  const approvedVideo = videos.find(v => v.approved === true) || videos.find(v => v.id === localApprovedVideoId)
  // Project is approved but this specific video is NOT individually approved
  const isProjectApprovedOnly = isApproved && !isCurrentVideoApproved && !hasAnyApprovedVideo && !hasLocallyApprovedVideoInGroup
  const commentsDisabled = isApproved || isCurrentVideoApproved || hasAnyApprovedVideo || hasLocallyApprovedVideoInGroup

  // Set of video IDs that are considered approved (server-side + optimistic local).
  // Used to gate per-comment edit/delete for non-admin viewers.
  const approvedVideoIds = useMemo(() => {
    const ids = new Set<string>()
    for (const v of videos) {
      if (v.approved === true) ids.add(v.id)
    }
    if (localApprovedVideoId) ids.add(localApprovedVideoId)
    return ids
  }, [videos, localApprovedVideoId])

  // Always use hook comments (includes optimistic updates)
  // Local comments only used as fallback if hook hasn't loaded
  const mergedComments = comments.length > 0 ? comments : localComments

  const videoDurationById = useMemo(() => {
    const map = new Map<string, number>()
    for (const v of videos || []) {
      if (v?.id && typeof v.duration === 'number') {
        map.set(v.id, v.duration)
      }
    }
    return map
  }, [videos])

  // Track the player's playhead (throttled videoTimeUpdated events, ~200ms during
  // playback) so comments at/within the current position can highlight.
  const [playhead, setPlayhead] = useState<{ time: number; videoId: string } | null>(null)
  useEffect(() => {
    const handlePlayheadTime = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (typeof detail?.time !== 'number' || !detail?.videoId) return
      setPlayhead({ time: detail.time, videoId: detail.videoId })
    }
    window.addEventListener('videoTimeUpdated', handlePlayheadTime as EventListener)
    return () => window.removeEventListener('videoTimeUpdated', handlePlayheadTime as EventListener)
  }, [])

  const videoFpsById = useMemo(() => {
    const map = new Map<string, number>()
    for (const v of videos || []) {
      if (v?.id) map.set(v.id, Number((v as any).fps) || 24)
    }
    return map
  }, [videos])

  // A comment is "at the playhead" when the playhead sits inside its range, or
  // within half a second of a point comment's timecode.
  const isCommentAtPlayhead = useCallback((comment: any): boolean => {
    if (!playhead || !comment?.timecode || comment.videoId !== playhead.videoId) return false
    const fps = videoFpsById.get(comment.videoId) || 24
    try {
      const start = timecodeToSeconds(String(comment.timecode), fps)
      if (!Number.isFinite(start)) return false
      const end = comment.timecodeEnd ? timecodeToSeconds(String(comment.timecodeEnd), fps) : null
      if (end !== null && Number.isFinite(end) && end > start) {
        return playhead.time >= start && playhead.time <= end
      }
      return Math.abs(playhead.time - start) <= 0.5
    } catch {
      return false
    }
  }, [playhead, videoFpsById])

  // Filter comments based on currently selected video
  const displayComments = (() => {
    if (!selectedVideoId) {
      // No video selected - show all or latest version only
      return restrictToLatestVersion && latestVideoVersion
        ? mergedComments.filter(comment => comment.videoVersion === latestVideoVersion)
        : mergedComments
    }

    // Both admin and share page: show comments for specific videoId only
    return mergedComments.filter(comment => comment.videoId === selectedVideoId)
  })()

  const sortedComments = [...displayComments].sort((a, b) => {
    if (commentSortMode === 'date') {
      // Newest first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    }

    // Sort by timecode (ascending). If multiple videos are displayed, group by videoId first.
    if (!selectedVideoId && a.videoId !== b.videoId) {
      return a.videoId.localeCompare(b.videoId)
    }

    const aTimecode = a.timecode || '00:00:00:00'
    const bTimecode = b.timecode || '00:00:00:00'
    const timecodeCmp = aTimecode.localeCompare(bTimecode)
    if (timecodeCmp !== 0) return timecodeCmp

    // Secondary sort for deterministic ordering
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })

  // Sort replies under each parent chronologically
  sortedComments.forEach(comment => {
    if (comment.replies && comment.replies.length > 0) {
      comment.replies.sort((a: Comment, b: Comment) => {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })
    }
  })

  // Auto-scroll only when a comment is posted.
  useEffect(() => {
    const container = messagesContainerRef.current
    const pending = pendingScrollRef.current
    if (!container || !pending) return

    const scrollTargetId = pending.parentId || pending.commentId
    const isReply = Boolean(pending.parentId)

    // For date sorting (newest-first), show new top-level messages at the top
    if (commentSortMode === 'date' && !isReply) {
      requestAnimationFrame(() => {
        container.scrollTop = 0
        pendingScrollRef.current = null
      })
      return
    }

    // For timecode sorting (or replies), scroll to the relevant bubble.
    requestAnimationFrame(() => {
      const element = document.getElementById(`comment-${scrollTargetId}`)
      if (element) {
        handleScrollToComment(scrollTargetId)
        pendingScrollRef.current = null
        pendingScrollAttemptsRef.current = 0
        return
      }

      // If the server refresh hasn't rendered it yet, retry briefly.
      if (pendingScrollAttemptsRef.current < 10) {
        pendingScrollAttemptsRef.current += 1
        setTimeout(() => {
          // Trigger effect by keeping ref; the next render (router.refresh) will re-run anyway.
          // As a fallback, attempt scrolling directly here too.
          const el = document.getElementById(`comment-${scrollTargetId}`)
          if (el) {
            handleScrollToComment(scrollTargetId)
            pendingScrollRef.current = null
            pendingScrollAttemptsRef.current = 0
          }
        }, 100)
      } else {
        pendingScrollRef.current = null
        pendingScrollAttemptsRef.current = 0
      }
    })
  }, [displayComments, commentSortMode])

  // Check if commenting on current video is allowed
  const isCurrentVideoAllowed = () => {
    if (!restrictToLatestVersion) return true
    if (!selectedVideoId) return true
    const selectedVideo = videos.find(v => v.id === selectedVideoId)
    if (!selectedVideo) return true
    return selectedVideo.version === latestVideoVersion
  }

  const currentVideoRestricted = Boolean(restrictToLatestVersion && selectedVideoId && !isCurrentVideoAllowed())
  const restrictionMessage = currentVideoRestricted
    ? `You can only leave feedback on the latest version. Please switch to version ${latestVideoVersion} to comment.`
    : undefined

  // Format message time
  const formatMessageTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - new Date(date).getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return formatDate(date)
  }

  const handleSeekToTimestamp = (timestamp: number, videoId: string, videoVersion: number | null) => {
    // Check if we're on a page with a video player by checking if the event listener exists
    const hasVideoPlayer = typeof window !== 'undefined' && document.querySelector('video')

    if (hasVideoPlayer) {
      // If video player is present (admin share page or public share page), dispatch event
      window.dispatchEvent(new CustomEvent('seekToTime', {
        detail: { timestamp, videoId, videoVersion }
      }))
    } else if (isAdminView) {
      // If in admin view without video player, navigate to admin share page with timestamp
      const video = videos.find(v => v.id === videoId)
      if (!video) return

      // Navigate to admin share page with video, version, and timestamp parameters
      const adminShareUrl = `/admin/projects/${projectId}/share?video=${encodeURIComponent(video.name)}&version=${videoVersion || video.version}&t=${Math.floor(timestamp)}`
      window.location.href = adminShareUrl
    }
  }

  const handleScrollToComment = (commentId: string) => {
    const element = document.getElementById(`comment-${commentId}`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })

      // Brief highlight effect (flash inside the comment block)
      const block = element.querySelector('[data-comment-block]') as HTMLElement | null
      const highlightEl = block || (element as HTMLElement)

      try {
        if (typeof (highlightEl as any).animate === 'function') {
          ;(highlightEl as any).animate(
            [
              { backgroundColor: 'hsl(var(--primary) / 0.18)' },
              { backgroundColor: 'hsl(var(--primary) / 0.08)' },
              { backgroundColor: 'transparent' },
            ],
            { duration: 900, easing: 'ease-out' }
          )
        } else {
          highlightEl.style.transition = 'background-color 0.3s'
          highlightEl.style.backgroundColor = 'hsl(var(--primary) / 0.12)'
          setTimeout(() => {
            highlightEl.style.backgroundColor = ''
          }, 900)
        }
      } catch {
        // ignore
      }
    }
  }

  const scrollToInput = () => {
    const el = document.getElementById('feedback-input')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    ;(el as HTMLTextAreaElement).focus?.()
  }

  // Allow other UI (e.g. timeline markers) to scroll the feedback pane to a comment.
  useEffect(() => {
    const handleScrollRequest = (e: CustomEvent) => {
      const commentId = e.detail?.commentId as string | undefined
      if (!commentId) return
      handleScrollToComment(commentId)
    }

    window.addEventListener('scrollToComment' as any, handleScrollRequest as EventListener)
    return () => {
      window.removeEventListener('scrollToComment' as any, handleScrollRequest as EventListener)
    }
  }, [])

  const handleOpenShortcuts = () => {
    window.dispatchEvent(new CustomEvent('openShortcutsDialog'))
  }

  const hasAnyApprovedVideoInGroup = videos.some(v => v.approved === true) || hasLocallyApprovedVideoInGroup
  const selectableVideos = hasAnyApprovedVideoInGroup && !isAdminView
    ? videos.filter(v => v.approved === true || v.id === localApprovedVideoId)
    : videos

  const sortedVideoVersions = useMemo(() => {
    return [...selectableVideos].sort((a, b) => {
      const aCreated = new Date((a as any).createdAt as any).getTime()
      const bCreated = new Date((b as any).createdAt as any).getTime()
      if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
        return bCreated - aCreated
      }
      return (b as any).version - (a as any).version
    })
  }, [selectableVideos])

  const latestSelectableVideo = sortedVideoVersions[0] || null
  const headerVideo = currentVideo || latestSelectableVideo
  const headerVideoName = headerVideo ? headerVideo.name : 'Video'
  const headerVideoNotes = String(headerVideo?.videoNotes || '').trim()
  const isHeaderVideoLocallyApproved = Boolean(headerVideo?.id && localApprovedVideoId === headerVideo.id)
  const approvalEnabledForHeaderVideo = Boolean(headerVideo?.allowApproval)
  const headerVideoFileSizeBytes = parseVideoFileSize(headerVideo?.originalFileSize)

  // "Request Next Version" (client share page only, one-shot per version).
  const isHeaderVideoRevisionRequested = Boolean(
    headerVideo?.id && ((headerVideo as any).revisionRequestedAt || localRevisionRequestedVideoId === headerVideo.id)
  )
  const headerVideoHasClientComment = Boolean(
    headerVideo?.id && comments.some((c: any) =>
      (!c.isInternal && c.videoId === headerVideo.id) ||
      (c.replies || []).some((r: any) => !r.isInternal && r.videoId === headerVideo.id)
    )
  )
  const showRequestNextVersion = Boolean(
    !isAdminView &&
    showVideoActions &&
    showApproveButton &&
    headerVideo &&
    // Only the latest version can lodge the request — on older versions the header
    // already points at the newer version.
    latestSelectableVideo &&
    headerVideo.id === latestSelectableVideo.id &&
    headerVideoHasClientComment &&
    !isHeaderVideoRevisionRequested &&
    !isApproved &&
    !headerVideo?.approved &&
    !hasAnyApprovedVideoInGroup &&
    !hasLocallyApprovedVideoInGroup
  )

  const showApproveVideoButton = Boolean(
    showVideoActions &&
    showApproveButton &&
    approvalEnabledForHeaderVideo &&
    !isApproved &&
    !headerVideo?.approved &&
    !hasAnyApprovedVideoInGroup &&
    !hasLocallyApprovedVideoInGroup &&
    !isHeaderVideoRevisionRequested
  )

  // The List Controls row only renders when it has real actions; otherwise the sort
  // toggle floats over the message list so the row's vertical space is reclaimed.
  const showListActionsRow = isAdminView || showApproveVideoButton || showRequestNextVersion

  const showOlderVersionNote = Boolean(
    !restrictToLatestVersion &&
      sortedVideoVersions.length > 1 &&
      selectedVideoId &&
      latestSelectableVideo &&
      selectedVideoId !== latestSelectableVideo.id
  )

  // When the requested next version has since been uploaded, the "requested" banner
  // flips to "available" with a jump-to-it button (sortedVideoVersions is newest-first).
  const newerVersionThanHeader = headerVideo
    ? sortedVideoVersions.find(v => ((v as any).version ?? 0) > ((headerVideo as any).version ?? 0)) || null
    : null

  const handleSelectVideoVersion = (videoId: string) => {
    // Update comments immediately
    window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId } }))

    // Reset playback time when switching versions.
    // (If there is no player, these are harmless no-ops.)
    window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId } }))
    window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId, videoVersion: null } }))
    setShowApproveConfirm(false)
  }

  const handleDownloadSelected = () => {
    const video = headerVideo
    if (!video) return
    if (!video.approved && !isApproved && !isHeaderVideoLocallyApproved) return

    const folderName = String(video?.name || headerVideoName || '').trim()
    window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
      detail: { folderName },
    }))
  }

  const handleApproveSelected = async () => {
    const video = headerVideo
    if (!video) return
    if (!approvalEnabledForHeaderVideo) {
      toast.error('Approval is disabled for this version.')
      return
    }
    if (approvingRef.current) return
    approvingRef.current = true

    setApproving(true)
    try {
      const url = `/api/projects/${projectId}/approve`
      // Thread the client's chosen identity through so the activity feed attributes
      // the approval to them by name (matching their comments) rather than a generic
      // "Client". Admin approvals are attributed from the authenticated admin user.
      const approveBody = JSON.stringify(
        isAdminView
          ? { selectedVideoId: video.id }
          : {
              selectedVideoId: video.id,
              recipientId: management.recipientId || null,
              authorName: management.authorName || null,
            }
      )
      const response = isAdminView
        ? await apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: approveBody,
          })
        : shareToken
          ? await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${shareToken}`,
              },
              body: approveBody,
            })
          : await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: approveBody,
            })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to approve video')
      }

      // After approve, immediately update local state so the banner and download modal
      // appear without waiting for the async prop-refresh chain.
      setLocalApprovedVideoId(video.id)
      if (!isAdminView) {
        const folderName = String(video?.name || headerVideoName || '').trim()
        window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
          detail: { folderName },
        }))
      }

      window.dispatchEvent(new CustomEvent('videoApprovalChanged', { detail: { videoId: video.id } }))
      setShowApproveConfirm(false)
      router.refresh()
    } catch (error) {
      toast.error(`Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      approvingRef.current = false
      setApproving(false)
    }
  }

  const handleRequestNextVersion = async () => {
    const video = headerVideo
    if (!video) return
    if (requestingNextRef.current) return
    requestingNextRef.current = true

    setRequestingNext(true)
    try {
      const url = `/api/projects/${projectId}/request-next-version`
      const requestBody = JSON.stringify({
        selectedVideoId: video.id,
        recipientId: management.recipientId || null,
        authorName: management.authorName || null,
      })
      const response = shareToken
        ? await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
            },
            body: requestBody,
          })
        : await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
          })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to request next version')
      }

      // Optimistically flip the local state so the banner and Reviewed badge appear
      // without waiting for the async prop-refresh chain.
      setLocalRevisionRequestedVideoId(video.id)
      setShowRequestNextConfirm(false)
      toast.success('Next version requested')
      // Trigger the share page's project + files refetch (the SSE echo guard suppresses
      // our own event). No videoId in the detail — that would mark it locally APPROVED.
      window.dispatchEvent(new CustomEvent('videoApprovalChanged', { detail: {} }))
      router.refresh()
    } catch (error) {
      toast.error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      requestingNextRef.current = false
      setRequestingNext(false)
    }
  }

  const fullscreenChatOverlay =
    isVideoFullscreen && isFullscreenChatOpen && fullscreenChatPortalTarget
      ? createPortal(
          <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-60 w-[min(720px,calc(100vw-2rem))]">
            <div className="relative rounded-lg border border-border bg-card shadow-elevation-sm opacity-50 hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <div className="absolute -top-4 right-3 z-10">
                <div className="rounded-full border border-border bg-card shadow-elevation-sm">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Close comments"
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('fullscreenChatSetOpen', {
                          detail: { open: false },
                        })
                      )
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="p-3">
                <CommentInput
                  newComment={newComment}
                  onCommentChange={handleCommentChange}
                  onSubmit={handleSubmitComment}
                  loading={loading}
                  uploadProgress={uploadProgress}
                  uploadStatusText={uploadStatusText}
                  onFileSelect={onFileSelect}
                  attachedFiles={attachedFiles}
                  onRemoveFile={onRemoveFile}
                  voiceNoteDraft={management.voiceNoteDraft}
                  onVoiceNoteSelect={management.onVoiceNoteSelect}
                  onVoiceNoteClear={management.onVoiceNoteClear}
                  allowFileUpload={allowCommentFileUpload}
                  clientUploadQuota={clientUploadQuota}
                  onRefreshUploadQuota={refreshClientUploadQuota}
                  selectedTimestamp={selectedTimestamp}
                  selectedEndTimestamp={selectedEndTimestamp}
                  onClearTimestamp={handleClearTimestamp}
                  onClearRange={management.handleClearRange}
                  onSetTimes={management.handleSetCommentTimes}
                  videoDurationSeconds={selectedVideoId ? videoDurationById.get(selectedVideoId) : undefined}
                  showTimestampReset={management.shouldShowTimestampReset}
                  selectedVideoFps={selectedVideoFps}
                  useFullTimecode={useFullTimecode}
                  replyingToComment={replyingToComment}
                  onCancelReply={handleCancelReply}
                  showAuthorInput={!isAdminView && isPasswordProtected}
                  authorName={authorName}
                  onAuthorNameChange={setAuthorName}
                  recipients={recipients}
                  currentVideoRestricted={currentVideoRestricted}
                  restrictionMessage={restrictionMessage}
                  commentsDisabled={commentsDisabled}
                  showShortcutsButton={showShortcutsButton}
                  onShowShortcuts={handleOpenShortcuts}
                  showTopBorder={false}
                  dialogPortalContainer={fullscreenChatPortalTarget}
                  isInFullscreenMode={true}
                />
              </div>
            </div>
          </div>,
          fullscreenChatPortalTarget
        )
      : null

  return (
    <>
      {fullscreenChatOverlay}
      <Card className={cn("bg-card border border-border flex flex-col h-full flex-1 min-h-0 rounded-lg overflow-hidden", cardClassName)} data-comment-section>
        {(!hideVideoTitle || showVideoActions) ? (
        <CardHeader className={cn("px-4 py-4 border-b border-border shrink-0 space-y-1", hideVideoTitle && !showVideoActions && "hidden")}>
        <div className="flex items-start gap-4">
          {!hideVideoTitle && (
          <div className="min-w-0 flex-1">
            <CardTitle className="text-lg font-semibold text-foreground whitespace-normal wrap-break-word leading-snug">
              {headerVideoName}
            </CardTitle>

            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Version:</span>
              <span className="text-foreground font-medium">
                {headerVideo?.versionLabel || '—'}
              </span>
              {showVideoActions ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowVideoInfo(true)}
                  title="Video Information"
                  aria-label="Video Information"
                >
                  <Info className="w-3.5 h-3.5" />
                </Button>
              ) : null}
              {showVideoActions ? (
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="h-7 w-7 shrink-0 sm:hidden"
                    onClick={openGuestLinkDialog}
                    title="Share"
                    aria-label="Share"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-7 shrink-0 hidden sm:inline-flex"
                    onClick={openGuestLinkDialog}
                    title="Share"
                    aria-label="Share"
                  >
                    <Share2 className="w-3.5 h-3.5 mr-1.5" />
                    Share
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          )}
          {showVideoActions ? (
            <div className={cn("flex items-center gap-2 shrink-0", hideVideoTitle && "ml-auto")}>
              <Dialog open={guestLinkDialogOpen} onOpenChange={setGuestLinkDialogOpen}>
                <DialogContent className="max-h-[85dvh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Share Video</DialogTitle>
                    <DialogDescription>
                      View-only link for the currently selected video version. The viewer cannot access other videos, see or leave comments, approve videos or download videos.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="mt-2 space-y-4">
                    <div className={cn(
                      "rounded-md border p-3",
                      guestLinkExpired ? "border-destructive/60 bg-destructive/5" : "border-border bg-muted/30"
                    )}>
                      <div className="text-sm font-medium text-foreground">Video-only link (expires in 14 days)</div>

                      {guestLinkExpired ? (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-3 text-destructive">
                          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                          <div className="text-sm">
                            <div className="font-semibold">This link has expired</div>
                            <div className="mt-0.5">Viewers can no longer open it. Use Refresh Expiry to reactivate it for another 14 days.</div>
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-3 flex items-center gap-2">
                        {!guestLinkUrl && guestLinkCheckedExisting && guestLinkMissing ? (
                          <Button
                            type="button"
                            variant="default"
                            onClick={generateGuestVideoLink}
                            disabled={guestLinkGenerating || !selectedVideoId}
                          >
                            {guestLinkGenerating ? 'Generating…' : 'Generate Video Link'}
                          </Button>
                        ) : null}

                        {guestLinkUrl ? (
                          <>
                            <Button type="button" variant="outline" onClick={copyGuestLink}>
                              {guestLinkCopied ? 'Copied Video Link' : 'Copy Video Link'}
                            </Button>
                            <Button
                              type="button"
                              variant={guestLinkExpired ? 'default' : 'outline'}
                              onClick={refreshGuestVideoLinkExpiry}
                              disabled={guestLinkRefreshing}
                            >
                              {guestLinkRefreshing ? 'Refreshing…' : 'Refresh Expiry'}
                            </Button>
                          </>
                        ) : null}
                      </div>

                      {guestLinkError ? (
                        <div className="mt-2 text-sm text-destructive">{guestLinkError}</div>
                      ) : null}

                      {guestLinkUrl ? (
                        <div className="mt-3 rounded-md border border-border bg-background/50 p-3">
                          <div className="text-xs text-muted-foreground mb-1">Share URL</div>
                          <div className="text-sm break-all font-mono">{guestLinkUrl}</div>
                          {guestLinkExpiresAt ? (
                            guestLinkExpired ? (
                              <div className="mt-2 text-xs font-semibold text-destructive">
                                Expired: {formatDateTime(guestLinkExpiresAt)}
                              </div>
                            ) : (
                              <div className="mt-2 text-xs text-muted-foreground">
                                Expires: {formatDateTime(guestLinkExpiresAt)}
                              </div>
                            )
                          ) : null}
                        </div>
                      ) : null}

                      {!guestLinkUrl && guestLinkLoadingExisting ? (
                        <div className="mt-3 text-xs text-muted-foreground">Loading existing link…</div>
                      ) : null}
                    </div>

                  </div>
                </DialogContent>
              </Dialog>

                  {showVideoActions ? (
                    <>
                      <Dialog open={showVideoInfo} onOpenChange={setShowVideoInfo}>
                        <DialogContent className="max-w-[95vw] sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>Video Information</DialogTitle>
                          <DialogDescription className="text-muted-foreground">
                            Detailed metadata for this version
                          </DialogDescription>
                        </DialogHeader>

                        {headerVideo ? (
                          <div className="space-y-3 text-xs sm:text-sm">
                            <div className="flex flex-col gap-1">
                              <span className="text-muted-foreground">Filename:</span>
                              <span className="font-medium break-all text-xs sm:text-sm">{headerVideo.originalFileName}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">File Size:</span>
                              <span className="font-medium">{headerVideoFileSizeBytes ? formatFileSize(headerVideoFileSizeBytes) : 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Resolution:</span>
                              <span className="font-medium">{headerVideo.width}x{headerVideo.height}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Codec:</span>
                              <span className="font-medium">{headerVideo.codec || 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Duration:</span>
                              <span className="font-medium">{formatTimestamp(headerVideo.duration)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">FPS:</span>
                              <span className="font-medium">{headerVideo.fps ? Number(headerVideo.fps).toFixed(2) : 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Upload Date:</span>
                              <span className="font-medium">{headerVideo.createdAt ? formatDate(headerVideo.createdAt) : '—'}</span>
                            </div>

                          </div>
                        ) : null}
                      </DialogContent>
                    </Dialog>
                    </>
                  ) : null}
            </div>
          ) : null}
        </div>
        </CardHeader>
        ) : null}

      <CardContent className="flex-1 flex flex-col p-0! overflow-hidden min-h-0">
        <Dialog open={showApproveConfirm} onOpenChange={setShowApproveConfirm}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Approve Video</DialogTitle>
              <DialogDescription>
                {headerVideo
                  ? `Approve ${headerVideo.versionLabel || 'this version'} for ${headerVideoName}? This will lock further feedback and make it downloadable.`
                  : 'Approve this version? This will lock further feedback and make it downloadable.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowApproveConfirm(false)}
                disabled={approving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="success"
                onClick={() => void handleApproveSelected()}
                disabled={approving}
              >
                {approving ? 'Approving...' : 'Approve'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showRequestNextConfirm} onOpenChange={setShowRequestNextConfirm}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Request Next Version</DialogTitle>
              <DialogDescription>
                {headerVideo
                  ? `Request the next version of ${headerVideoName}? Your feedback on ${headerVideo.versionLabel || 'this version'} will be locked in, but you can still add comments.`
                  : 'Request the next version? Your feedback on this version will be locked in, but you can still add comments.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowRequestNextConfirm(false)}
                disabled={requestingNext}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={() => void handleRequestNextVersion()}
                disabled={requestingNext}
              >
                {requestingNext ? 'Requesting...' : 'Request Next Version'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

                {/* Approval Status Banner */}
        {commentsDisabled && isProjectApprovedOnly && (
                    <div className="bg-primary border-b border-border py-3 px-4 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <h3 className="text-white font-medium">
                    Project Approved
                  </h3>
                  <p className="text-sm text-white/80">
                    Downloads were not enabled for this version.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
        {commentsDisabled && !isProjectApprovedOnly && (
          <div className="bg-success-visible border-b border-border py-3 px-4 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <CheckCircle2 className="w-8 h-8 text-success shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-foreground font-medium">
                    Video Approved
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {approvedVideo
                      ? `${approvedVideo.versionLabel} is ready for download from the Files section.`
                      : 'A version is ready for download from the Files section.'}
                  </p>
                </div>
              </div>

              {showVideoActions && headerVideo && (headerVideo?.approved || isHeaderVideoLocallyApproved) ? (
                <div className="shrink-0">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleDownloadSelected}
                  >
                    Download
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}
        {/* Next Version Requested banner (video is "Reviewed" on the share page).
            Once the next version has actually been uploaded, it flips to "available"
            with a button that jumps to the newer version. */}
        {!commentsDisabled && isHeaderVideoRevisionRequested && (
          <div className="bg-primary/10 border-b border-border py-3 px-4 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <FileClock className="w-8 h-8 text-primary shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-foreground font-medium">
                    {newerVersionThanHeader ? 'Next version available' : 'Next version requested'}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {newerVersionThanHeader
                      ? `${newerVersionThanHeader.versionLabel || 'A newer version'} is ready for review. Feedback on this version is locked, but you can still add comments.`
                      : "We're working on the next version of this video. Your feedback is locked in, but you can still add comments."}
                  </p>
                </div>
              </div>
              {newerVersionThanHeader ? (
                <div className="shrink-0">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleSelectVideoVersion(newerVersionThanHeader.id)}
                    title={newerVersionThanHeader.versionLabel ? `View ${newerVersionThanHeader.versionLabel}` : 'View the latest version'}
                  >
                    View
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {!hideInput && (
          <CommentInput
            newComment={newComment}
            onCommentChange={handleCommentChange}
            onSubmit={handleSubmitComment}
            loading={loading}
            uploadProgress={uploadProgress}
            uploadStatusText={uploadStatusText}
            onFileSelect={onFileSelect}
            attachedFiles={attachedFiles}
            onRemoveFile={onRemoveFile}
            voiceNoteDraft={management.voiceNoteDraft}
            onVoiceNoteSelect={management.onVoiceNoteSelect}
            onVoiceNoteClear={management.onVoiceNoteClear}
            allowFileUpload={allowCommentFileUpload}
            clientUploadQuota={clientUploadQuota}
            onRefreshUploadQuota={refreshClientUploadQuota}
            selectedTimestamp={selectedTimestamp}
            selectedEndTimestamp={selectedEndTimestamp}
            onClearTimestamp={handleClearTimestamp}
            onClearRange={management.handleClearRange}
            onSetTimes={management.handleSetCommentTimes}
            videoDurationSeconds={selectedVideoId ? videoDurationById.get(selectedVideoId) : undefined}
            showTimestampReset={management.shouldShowTimestampReset}
            selectedVideoFps={selectedVideoFps}
            useFullTimecode={useFullTimecode}
            replyingToComment={replyingToComment}
            onCancelReply={handleCancelReply}
            showAuthorInput={!isAdminView && isPasswordProtected}
            authorName={authorName}
            onAuthorNameChange={setAuthorName}
            recipients={recipients}
            currentVideoRestricted={currentVideoRestricted}
            restrictionMessage={restrictionMessage}
            commentsDisabled={commentsDisabled}
            showShortcutsButton={showShortcutsButton}
            onShowShortcuts={handleOpenShortcuts}
          />
        )}

        {showVideoNotes && headerVideoNotes ? (
          <div className="border-b border-border bg-muted/20 shrink-0">
            <button
              type="button"
              className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-muted/30 transition-colors"
              onClick={() => setVersionNotesOpen(prev => !prev)}
            >
              <ChevronDown
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground transition-transform',
                  !versionNotesOpen && '-rotate-90'
                )}
              />
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Version Notes
              </p>
            </button>
            {versionNotesOpen && (
              <p className="px-4 pb-3 text-sm text-foreground whitespace-pre-wrap wrap-break-word">
                {headerVideoNotes}
              </p>
            )}
          </div>
        ) : null}

        {/* List Controls (directly above the message list). Skipped entirely when there
            are no action buttons — the sort toggle then floats over the message list. */}
        {showListActionsRow ? (
        <div className="px-4 py-2 border-b border-border bg-card shrink-0">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
              {isAdminView && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleExportCommentsSrt}
                  disabled={exportingSrt}
                  className="whitespace-nowrap"
                >
                  {exportingSrt ? 'Exporting...' : 'Export Comments'}
                </Button>
              )}
              {showApproveVideoButton ? (
                <Button
                  variant="success"
                  size="sm"
                  onClick={() => setShowApproveConfirm(true)}
                  disabled={approving}
                >
                  Approve Video
                </Button>
              ) : null}
              {showRequestNextVersion ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowRequestNextConfirm(true)}
                  disabled={requestingNext}
                >
                  Request Next Version
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <div className="shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={commentSortMode === 'timecode' ? 'Sorted by timecode — switch to newest first' : 'Sorted by newest — switch to timecode'}
                  title={commentSortMode === 'timecode' ? 'Sorted by timecode — switch to newest first' : 'Sorted by newest — switch to timecode'}
                  className="h-8 w-8 p-0"
                  onClick={() => setCommentSortMode(commentSortMode === 'timecode' ? 'date' : 'timecode')}
                >
                  {commentSortMode === 'timecode' ? <Clock className="h-4 w-4" /> : <History className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
          {showRequestNextVersion ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              All feedback submitted? Click <span className="font-medium text-foreground">Request Next Version</span>{' '}to let us know you&apos;re done with this version.
            </p>
          ) : null}
        </div>
        ) : null}

        {/* Approved notice above the comment list — styled like the "All feedback
            submitted?" prompt for consistency. The no-comments empty state below
            has its own larger version of this message. */}
        {commentsDisabled && sortedComments.length > 0 ? (
          <div className="px-4 py-2 border-b border-border bg-card shrink-0">
            <p className="text-xs text-muted-foreground">
              {isProjectApprovedOnly
                ? 'This project has been approved. Comments are now closed.'
                : 'This video has been approved. Comments are now closed.'}
            </p>
          </div>
        ) : null}

        {/* Messages Area - Threaded Conversations */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          {!showListActionsRow && sortedComments.length > 1 ? (
            <div className="absolute top-2 right-3 z-10">
              <Button
                variant="outline"
                size="sm"
                aria-label={commentSortMode === 'timecode' ? 'Sorted by timecode — switch to newest first' : 'Sorted by newest — switch to timecode'}
                title={commentSortMode === 'timecode' ? 'Sorted by timecode — switch to newest first' : 'Sorted by newest — switch to timecode'}
                className="h-8 w-8 p-0 bg-card/90 shadow-sm"
                onClick={() => setCommentSortMode(commentSortMode === 'timecode' ? 'date' : 'timecode')}
              >
                {commentSortMode === 'timecode' ? <Clock className="h-4 w-4" /> : <History className="h-4 w-4" />}
              </Button>
            </div>
          ) : null}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0 bg-muted/70">
          {sortedComments.length === 0 ? (
            <div className="text-center py-12">
              {commentsDisabled ? (
                <div className="w-12 h-12 rounded-full bg-muted mx-auto mb-3 flex items-center justify-center">
                  <Lock className="w-5 h-5 text-muted-foreground" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-full bg-muted mx-auto mb-3 flex items-center justify-center">
                  <MessageCircle className="w-5 h-5 text-muted-foreground" />
                </div>
              )}
              <p className="text-muted-foreground">
                {commentsDisabled && isProjectApprovedOnly
                  ? 'This project has been approved. Comments are now closed.'
                  : commentsDisabled
                    ? 'This video has been approved. Comments are now closed.'
                    : 'Leave feedback here — comments are time-stamped to the video.'}
              </p>
            </div>
          ) : (
            <>
              {sortedComments.map((comment) => {
                const isViewerMessage = isAdminView ? comment.isInternal : !comment.isInternal
                const hasReplies = comment.replies && comment.replies.length > 0
                const isRecipientAuthored = (c: any) => {
                  if (c?.authorType) return c.authorType === 'RECIPIENT'
                  // Back-compat fallback (less strict): only non-internal.
                  return !c?.isInternal
                }

                // Locked comments (next version requested) are no longer client-deletable.
                // Comments on approved videos are also not client-deletable.
                const canDeleteParent = canAdminDelete || (canClientDelete && isRecipientAuthored(comment) && !(comment as any).lockedAt && !approvedVideoIds.has((comment as any).videoId))
                const allowAnyReplyDelete = canAdminDelete || canClientDelete
                const canDeleteReply = (reply: Comment) => canAdminDelete || (canClientDelete && isRecipientAuthored(reply) && !(reply as any).lockedAt && !approvedVideoIds.has((reply as any).videoId))

                // Editing is limited to the viewer's own comments. Admins can always edit
                // their own; clients need the edit/delete setting on, a recipient-authored
                // comment matching their name, no lock (next version not yet requested),
                // and the video must not be approved.
                const canEditOwn = (c: any) => isAdminView
                  ? isOwnComment(c)
                  : (canClientDelete && isRecipientAuthored(c) && isOwnComment(c) && !c?.lockedAt && !approvedVideoIds.has(c?.videoId))
                const canEditParent = canEditOwn(comment)
                const canEditReply = (reply: Comment) => canEditOwn(reply)

                // Apply optimistic "mark done" overrides for the admin share page tick.
                const commentForBubble = {
                  ...comment,
                  resolvedAt: effectiveResolvedAt(comment),
                  replies: comment.replies?.map((r: any) => ({ ...r, resolvedAt: effectiveResolvedAt(r) })),
                }

                return (
                  <div key={comment.id}>
                    {/* Parent Bubble that extends with replies */}
                    {!hasReplies ? (
                      // No replies - use normal MessageBubble
                      <MessageBubble
                        comment={commentForBubble}
                        isReply={false}
                        isStudio={comment.isInternal}
                        studioCompanyName={companyName}
                        clientCompanyName={clientCompanyName}
                        showFrames={showFrames}
                        timecodeDurationSeconds={videoDurationById.get(comment.videoId)}
                        parentComment={null}
                        onReply={() => {
                          handleReply(comment.id, comment.videoId)
                          if (!hideInput) scrollToInput()
                        }}
                        onSeekToTimestamp={handleSeekToTimestamp}
                        onDelete={canDeleteParent ? () => handleDeleteComment(comment.id) : undefined}
                        canEdit={canEditParent}
                        onSaveEdit={handleEditComment}
                        onScrollToComment={handleScrollToComment}
                        formatMessageTime={formatMessageTime}
                        commentsDisabled={commentsDisabled}
                        isViewerMessage={isViewerMessage}
                        onDownloadCommentFile={(shareToken || isAdminView) ? handleDownloadCommentFile : undefined}
                        onResolveCommentFilePlaybackUrl={(shareToken || isAdminView) ? resolveCommentFilePlaybackUrl : undefined}
                        showAuthorAvatar
                        showColorEdge={false}
                        avatarClassName={largeAvatars ? 'h-[30px] w-[30px] text-[12px] ring-2' : undefined}
                        showResolveControl={isAdminView}
                        onToggleResolved={handleToggleResolved}
                        isPlayheadActive={isCommentAtPlayhead(comment)}
                      />
                    ) : (
                      // Has replies - render extended bubble
                      <MessageBubble
                        comment={commentForBubble}
                        isReply={false}
                        isStudio={comment.isInternal}
                        studioCompanyName={companyName}
                        clientCompanyName={clientCompanyName}
                        showFrames={showFrames}
                        timecodeDurationSeconds={videoDurationById.get(comment.videoId)}
                        parentComment={null}
                        onReply={() => {
                          handleReply(comment.id, comment.videoId)
                          if (!hideInput) scrollToInput()
                        }}
                        onSeekToTimestamp={handleSeekToTimestamp}
                        onDelete={canDeleteParent ? () => handleDeleteComment(comment.id) : undefined}
                        canEdit={canEditParent}
                        canEditReply={canEditReply}
                        onSaveEdit={handleEditComment}
                        onScrollToComment={handleScrollToComment}
                        formatMessageTime={formatMessageTime}
                        commentsDisabled={commentsDisabled}
                        isViewerMessage={isViewerMessage}
                        replies={comment.replies}
                        onDeleteReply={allowAnyReplyDelete ? handleDeleteComment : undefined}
                        canDeleteReply={allowAnyReplyDelete ? canDeleteReply : undefined}
                        onDownloadCommentFile={(shareToken || isAdminView) ? handleDownloadCommentFile : undefined}
                        onResolveCommentFilePlaybackUrl={(shareToken || isAdminView) ? resolveCommentFilePlaybackUrl : undefined}
                        showAuthorAvatar
                        showColorEdge={false}
                        avatarClassName={largeAvatars ? 'h-[30px] w-[30px] text-[12px] ring-2' : undefined}
                        showResolveControl={isAdminView}
                        onToggleResolved={handleToggleResolved}
                        isPlayheadActive={isCommentAtPlayhead(comment)}
                      />
                    )}
                  </div>
                )
              })}
              {/* Invisible anchor for auto-scroll */}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
        </div>
      </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDeleteCommentId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteCommentId(null) }}
        title="Delete Comment?"
        description="This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteComment}
      />
    </>
  )
}

export default function CommentSection(props: CommentSectionProps) {
  const {
    projectId,
    comments: initialComments,
    videos = [],
    clientEmail,
    isPasswordProtected = false,
    adminUser = null,
    recipients = [],
    clientName,
    restrictToLatestVersion = false,
    shareToken = null,
    isAdminView = false,
    companyName = 'Studio',
    allowClientDeleteComments = false,
    allowClientUploadFiles = false,
  } = props

  const management = useCommentManagement({
    projectId,
    initialComments,
    videos,
    clientEmail,
    isPasswordProtected,
    adminUser,
    recipients,
    clientName,
    restrictToLatestVersion,
    shareToken,
    useAdminAuth: isAdminView,
    companyName,
    allowClientDeleteComments,
    allowClientUploadFiles,
  })

  return <CommentSectionView {...props} management={management} />
}
