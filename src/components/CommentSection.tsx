'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
// Avoid importing Prisma runtime types in client components.
type Comment = any
type Video = any
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { CheckCircle2, ChevronDown, ChevronRight, Info, Share2, X } from 'lucide-react'
import MessageBubble from './MessageBubble'
import CommentInput from './CommentInput'
import ThemeToggle from './ThemeToggle'
import { VideoAssetDownloadModal } from './VideoAssetDownloadModal'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { formatDate, formatTimestamp, formatDateTime } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRouter } from 'next/navigation'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface CommentSectionProps {
  projectId: string
  projectSlug?: string
  guestModeEnabled?: boolean
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
  hideInput?: boolean
  showVideoActions?: boolean
  showThemeToggle?: boolean
  showVideoNotes?: boolean
  showApproveButton?: boolean
}

type CommentManagement = ReturnType<typeof useCommentManagement>

export function CommentSectionView({
  projectId,
  projectSlug,
  guestModeEnabled = false,
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
  hideInput = false,
  showVideoActions = true,
  showThemeToggle = false,
  showVideoNotes = true,
  showApproveButton = true,
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
    setAuthorName,
    attachedFiles,
    onFileSelect,
    onRemoveFile,
    clientUploadQuota,
    refreshClientUploadQuota,
  } = management

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
  const showFrames = useFullTimecode
  const [showVideoInfo, setShowVideoInfo] = useState(false)
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
  const [projectGuestLinkCopied, setProjectGuestLinkCopied] = useState(false)
  const [showApproveConfirm, setShowApproveConfirm] = useState(false)
  const [approving, setApproving] = useState(false)
  
  const [exportingSrt, setExportingSrt] = useState(false)
  const [showDownloadOptions, setShowDownloadOptions] = useState(false)
  const [openDownloadAfterApprove, setOpenDownloadAfterApprove] = useState(false)
  const [videoNotesOpen, setVideoNotesOpen] = useState(true)
  const pendingScrollRef = useRef<{ commentId: string; parentId: string | null } | null>(null)
  const pendingScrollAttemptsRef = useRef(0)

  const canClientDelete = allowClientDeleteComments && !isAdminView
  const canAdminDelete = isAdminView && canAdminDeleteComments

  useEffect(() => {
    if (typeof window === 'undefined') return
    setOrigin(window.location.origin)
  }, [])

  const projectGuestUrl = (() => {
    const resolvedOrigin = origin || (typeof window !== 'undefined' ? window.location.origin : null)
    if (!resolvedOrigin) return null
    const slug = typeof projectSlug === 'string' ? projectSlug.trim() : ''
    if (!slug) return null
    return new URL(`/share/${encodeURIComponent(slug)}/guest`, resolvedOrigin).toString()
  })()

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
    if (!guestModeEnabled) return
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
    if (!guestModeEnabled) return
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
    if (!guestModeEnabled) return
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
  }, [guestModeEnabled, guestLinkDialogOpen, projectId, selectedVideoId, isAdminView, shareToken])

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

  const copyProjectGuestLink = async () => {
    if (!projectGuestUrl) return
    try {
      await navigator.clipboard.writeText(projectGuestUrl)
      setProjectGuestLinkCopied(true)
      setTimeout(() => setProjectGuestLinkCopied(false), 1500)
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
      alert(`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

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
        alert('No video selected to export comments for.')
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
      alert(`Failed to export comments: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
  const isCurrentVideoApproved = currentVideo ? (currentVideo as any).approved === true : false
  // Check if ANY video in the group is approved (for admin view with multiple versions)
  const hasAnyApprovedVideo = videos.some(v => (v as any).approved === true)
  const approvedVideo = videos.find(v => (v as any).approved === true)
  const commentsDisabled = isApproved || isCurrentVideoApproved || hasAnyApprovedVideo

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

  // Track which comments have expanded replies (default: all expanded)
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})

  const toggleReplies = (commentId: string) => {
    setExpandedReplies(prev => ({
      ...prev,
      [commentId]: !prev[commentId]
    }))
  }

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

  // Reset notes accordion when switching versions
  useEffect(() => {
    setVideoNotesOpen(true)
  }, [selectedVideoId])

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

  const hasAnyApprovedVideoInGroup = videos.some(v => (v as any).approved === true)
  const selectableVideos = hasAnyApprovedVideoInGroup
    ? videos.filter(v => (v as any).approved === true)
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
  const headerVideoName = headerVideo ? (headerVideo as any).name : 'Video'
  const approvalEnabledForHeaderVideo = Boolean((headerVideo as any)?.allowApproval)

  const showOlderVersionNote = Boolean(
    !restrictToLatestVersion &&
      sortedVideoVersions.length > 1 &&
      selectedVideoId &&
      latestSelectableVideo &&
      selectedVideoId !== latestSelectableVideo.id
  )

  useEffect(() => {
    if (!openDownloadAfterApprove) return

    // Only auto-open in the client/share view.
    if (isAdminView) {
      setOpenDownloadAfterApprove(false)
      return
    }

    if (!headerVideo) return
    if (!(headerVideo as any).approved) return

    setShowDownloadOptions(true)
    setOpenDownloadAfterApprove(false)
  }, [openDownloadAfterApprove, headerVideo, isAdminView])

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
    if (!(video as any).approved) return
    setShowDownloadOptions(true)
  }

  const handleApproveSelected = async () => {
    const video = headerVideo
    if (!video) return
    if (!approvalEnabledForHeaderVideo) {
      alert('Approval is disabled for this version.')
      return
    }
    if (approving) return

    setApproving(true)
    try {
      const url = `/api/projects/${projectId}/approve`
      const response = isAdminView
        ? await apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedVideoId: video.id }),
          })
        : shareToken
          ? await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${shareToken}`,
              },
              body: JSON.stringify({ selectedVideoId: video.id }),
            })
          : await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ selectedVideoId: video.id }),
            })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to approve video')
      }

      // After approve, open the download modal (share/client view).
      // router.refresh() will deliver updated approved state; the effect above waits for it.
      if (!isAdminView) {
        setOpenDownloadAfterApprove(true)
      }

      window.dispatchEvent(new CustomEvent('videoApprovalChanged'))
      setShowApproveConfirm(false)
      router.refresh()
    } catch (error) {
      alert(`Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setApproving(false)
    }
  }

  const fullscreenChatOverlay =
    isVideoFullscreen && isFullscreenChatOpen && fullscreenChatPortalTarget
      ? createPortal(
          <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-[60] w-[min(720px,calc(100vw-2rem))]">
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
                  allowFileUpload={allowClientUploadFiles && !isAdminView}
                  clientUploadQuota={clientUploadQuota}
                  onRefreshUploadQuota={refreshClientUploadQuota}
                  selectedTimestamp={selectedTimestamp}
                  onClearTimestamp={handleClearTimestamp}
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
      <Card className="bg-card border border-border flex flex-col h-full flex-1 min-h-0 rounded-lg overflow-hidden" data-comment-section>
        <CardHeader className="border-b border-border flex-shrink-0 space-y-1">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 w-full">
            <CardTitle className="text-lg font-semibold text-foreground whitespace-normal break-words leading-snug">
              {headerVideoName}
            </CardTitle>

            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-shrink-0">Version:</span>
              {restrictToLatestVersion || sortedVideoVersions.length <= 1 ? (
                <span className="text-foreground font-medium">
                  {(headerVideo as any)?.versionLabel || '—'}
                </span>
              ) : (
                <div className="flex-1 min-w-0 max-w-[180px] sm:max-w-[240px]">
                  <Select
                    value={selectedVideoId || latestSelectableVideo?.id || undefined}
                    onValueChange={handleSelectVideoVersion}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sortedVideoVersions.map((video) => (
                        <SelectItem key={video.id} value={video.id}>
                          {video.versionLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {showVideoActions || guestModeEnabled ? (
                <div className="ml-auto flex items-center gap-2">
                  {guestModeEnabled ? (
                    <>
                      {/* Mobile: icon-only */}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 sm:hidden"
                        onClick={() => {
                          setGuestLinkDialogOpen(true)
                          setGuestLinkUrl(null)
                          setGuestLinkExpiresAt(null)
                          setGuestLinkError(null)
                          setGuestLinkCheckedExisting(false)
                          setGuestLinkMissing(false)
                          setGuestLinkCopied(false)
                          setProjectGuestLinkCopied(false)
                        }}
                        disabled={!selectedVideoId}
                        aria-label="Share"
                        title="Share"
                      >
                        <Share2 className="w-4 h-4" />
                      </Button>

                      {/* Desktop: icon + text */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="hidden sm:inline-flex h-8"
                        onClick={() => {
                          setGuestLinkDialogOpen(true)
                          setGuestLinkUrl(null)
                          setGuestLinkExpiresAt(null)
                          setGuestLinkError(null)
                          setGuestLinkCheckedExisting(false)
                          setGuestLinkMissing(false)
                          setGuestLinkCopied(false)
                          setProjectGuestLinkCopied(false)
                        }}
                        disabled={!selectedVideoId}
                        aria-label="Share"
                        title="Share"
                      >
                        <Share2 className="w-4 h-4 mr-2" />
                        Share
                      </Button>

                      <Dialog open={guestLinkDialogOpen} onOpenChange={setGuestLinkDialogOpen}>
                        <DialogContent className="max-h-[85dvh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle>Guest Links</DialogTitle>
                            <DialogDescription>
                              Guests will not be able to see or leave comments, see version notes or approve videos.
                            </DialogDescription>
                          </DialogHeader>

                          <div className="mt-2 space-y-4">
                            <div className="rounded-md border border-border bg-muted/30 p-3">
                              <div className="text-sm font-medium text-foreground">Video-only link (expires in 14 days)</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                View-only link for the currently selected video version. The viewer cannot access other videos.
                              </div>

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
                                      variant="outline"
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
                                    <div className="mt-2 text-xs text-muted-foreground">
                                      Expires: {formatDateTime(guestLinkExpiresAt)}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              {!guestLinkUrl && guestLinkLoadingExisting ? (
                                <div className="mt-3 text-xs text-muted-foreground">Loading existing link…</div>
                              ) : null}
                            </div>

                            <div className="rounded-md border border-border bg-muted/30 p-3">
                              <div className="text-sm font-medium text-foreground">Project guest link (expires at project completion)</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                Opens the full project in guest mode (videos only, no comments/approvals).
                              </div>

                              {projectGuestUrl ? (
                                <>
                                  <div className="mt-3 flex items-center gap-2">
                                    <Button type="button" variant="outline" onClick={copyProjectGuestLink}>
                                      {projectGuestLinkCopied ? 'Copied' : 'Copy Project Guest Link'}
                                    </Button>
                                  </div>

                                  <div className="mt-3 rounded-md border border-border bg-background/50 p-3">
                                    <div className="text-xs text-muted-foreground mb-1">Share URL</div>
                                    <div className="text-sm break-all font-mono">{projectGuestUrl}</div>
                                  </div>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </>
                  ) : null}

                  {showVideoActions ? (
                    <Dialog open={showVideoInfo} onOpenChange={setShowVideoInfo}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setShowVideoInfo(true)}
                        title="Info"
                        aria-label="Info"
                      >
                        <Info className="w-4 h-4" />
                      </Button>

                      <DialogContent className="bg-background dark:bg-card border-border text-foreground dark:text-card-foreground max-w-[95vw] sm:max-w-md">
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
                              <span className="font-medium break-all text-xs sm:text-sm">{(headerVideo as any).originalFileName}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Resolution:</span>
                              <span className="font-medium">{(headerVideo as any).width}x{(headerVideo as any).height}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Codec:</span>
                              <span className="font-medium">{(headerVideo as any).codec || 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Duration:</span>
                              <span className="font-medium">{formatTimestamp((headerVideo as any).duration)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">FPS:</span>
                              <span className="font-medium">{(headerVideo as any).fps ? Number((headerVideo as any).fps).toFixed(2) : 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Upload Date:</span>
                              <span className="font-medium">{formatDate((headerVideo as any).createdAt)}</span>
                            </div>
                          </div>
                        ) : null}
                      </DialogContent>
                    </Dialog>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {showOlderVersionNote ? (
          <div className="mt-2 mb-2">
            <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              <span>Note: Newer version available.</span>
              <button
                type="button"
                className="underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 rounded-sm"
                onClick={() => {
                  if (!latestSelectableVideo) return
                  handleSelectVideoVersion(latestSelectableVideo.id)
                }}
              >
                Click here to view.
              </button>
            </div>
          </div>
        ) : null}

        {showVideoNotes && headerVideo?.videoNotes ? (
          <div className="border border-border rounded-lg bg-muted/20 overflow-hidden">
            <button
              type="button"
              onClick={() => setVideoNotesOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={videoNotesOpen}
            >
              <span className="font-medium text-foreground">Version Notes</span>
              {videoNotesOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
            {videoNotesOpen ? (
              <div className="px-3 pb-3 text-sm text-foreground whitespace-pre-wrap break-words">
                {headerVideo.videoNotes}
              </div>
            ) : null}
          </div>
        ) : null}

        {null}
        </CardHeader>

      <CardContent className="flex-1 flex flex-col !p-0 overflow-hidden min-h-0">
        {headerVideo && (headerVideo as any)?.approved ? (
          <VideoAssetDownloadModal
            videoId={headerVideo.id}
            videoName={headerVideoName}
            versionLabel={(headerVideo as any)?.versionLabel || '—'}
            isOpen={showDownloadOptions}
            onClose={() => setShowDownloadOptions(false)}
            shareToken={shareToken}
            isAdmin={isAdminView}
          />
        ) : null}

        {/* Approval Status Banner */}
        {commentsDisabled && (
          <div className="bg-success-visible border-b-2 border-success-visible p-4 flex-shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <CheckCircle2 className="w-8 h-8 text-success flex-shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-foreground font-medium">
                    {isApproved ? 'Project Approved' : 'Video Approved'}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {isApproved
                      ? 'The final version is ready for download.'
                      : approvedVideo
                      ? `${approvedVideo.versionLabel} of this video has been approved and is ready for download.`
                      : 'A version of this video has been approved and is ready for download.'}
                  </p>
                </div>
              </div>

              {showVideoActions && (headerVideo as any)?.approved ? (
                <div className="flex-shrink-0">
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
            allowFileUpload={allowClientUploadFiles && !isAdminView}
            clientUploadQuota={clientUploadQuota}
            onRefreshUploadQuota={refreshClientUploadQuota}
            selectedTimestamp={selectedTimestamp}
            onClearTimestamp={handleClearTimestamp}
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

        {/* List Controls (directly above the message list) */}
        <div className="px-4 sm:px-6 py-2 border-b border-border bg-card flex-shrink-0">
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

              {showVideoActions && (
                <>
                  {showApproveButton && approvalEnabledForHeaderVideo && !isApproved && !(headerVideo as any)?.approved && !hasAnyApprovedVideoInGroup ? (
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => setShowApproveConfirm(true)}
                      disabled={approving}
                      className="!bg-green-500 hover:!bg-green-600 text-white hover:opacity-100"
                    >
                      Approve Video
                    </Button>
                  ) : null}

                  {showThemeToggle && !isAdminView ? (
                    <div className="shrink-0">
                      <ThemeToggle buttonClassName="h-8 w-8" iconClassName="w-4 h-4" />
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <div className="flex-shrink-0">
                <Select
                  value={commentSortMode}
                  onValueChange={(v) => setCommentSortMode(v as 'timecode' | 'date')}
                >
                  <SelectTrigger className="h-8 w-auto px-2 pr-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="timecode">Timecode</SelectItem>
                    <SelectItem value="date">Newest</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {showVideoActions && showApproveButton && approvalEnabledForHeaderVideo && showApproveConfirm && (
            <div className="mt-2 border border-border rounded-lg p-3 bg-accent/30">
              <div className="text-sm text-foreground font-semibold">Approve this video?</div>
              <div className="text-xs text-muted-foreground mt-1">
                Version: <span className="font-medium text-foreground">{(headerVideo as any)?.versionLabel}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="success"
                  size="sm"
                  onClick={handleApproveSelected}
                  disabled={approving}
                  className="!bg-green-500 hover:!bg-green-600 text-white hover:opacity-100"
                >
                  {approving ? 'Approving...' : 'Yes, Approve'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowApproveConfirm(false)} disabled={approving}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Messages Area - Threaded Conversations */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto sidebar-scrollbar px-4 sm:px-6 py-4 space-y-3 min-h-0 bg-muted/30">
          {sortedComments.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-12 h-12 bg-muted rounded-full mx-auto mb-3" />
              <p className="text-muted-foreground">No messages yet. Start the conversation!</p>
            </div>
          ) : (
            <>
              {sortedComments.map((comment) => {
                const isViewerMessage = isAdminView ? comment.isInternal : !comment.isInternal
                const hasReplies = comment.replies && comment.replies.length > 0
                const repliesExpanded = expandedReplies[comment.id] ?? true // Default to expanded
                const isRecipientAuthored = (c: any) => {
                  if (c?.authorType) return c.authorType === 'RECIPIENT'
                  // Back-compat fallback (less strict): only non-internal.
                  return !c?.isInternal
                }

                const canDeleteParent = canAdminDelete || (canClientDelete && isRecipientAuthored(comment))
                const allowAnyReplyDelete = canAdminDelete || canClientDelete
                const canDeleteReply = (reply: Comment) => canAdminDelete || (canClientDelete && isRecipientAuthored(reply))

                return (
                  <div key={comment.id}>
                    {/* Parent Bubble that extends with replies */}
                    {!hasReplies ? (
                      // No replies - use normal MessageBubble
                      <MessageBubble
                        comment={comment}
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
                        onScrollToComment={handleScrollToComment}
                        formatMessageTime={formatMessageTime}
                        commentsDisabled={commentsDisabled}
                        isViewerMessage={isViewerMessage}
                        onDownloadCommentFile={(shareToken || isAdminView) ? handleDownloadCommentFile : undefined}
                        showAuthorAvatar
                        showColorEdge={false}
                      />
                    ) : (
                      // Has replies - render extended bubble
                      <MessageBubble
                        comment={comment}
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
                        onScrollToComment={handleScrollToComment}
                        formatMessageTime={formatMessageTime}
                        commentsDisabled={commentsDisabled}
                        isViewerMessage={isViewerMessage}
                        replies={comment.replies}
                        repliesExpanded={repliesExpanded}
                        onToggleReplies={() => toggleReplies(comment.id)}
                        onDeleteReply={allowAnyReplyDelete ? handleDeleteComment : undefined}
                        canDeleteReply={allowAnyReplyDelete ? canDeleteReply : undefined}
                        onDownloadCommentFile={(shareToken || isAdminView) ? handleDownloadCommentFile : undefined}
                        showAuthorAvatar
                        showColorEdge={false}
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
      </CardContent>
      </Card>
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
