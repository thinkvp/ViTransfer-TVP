'use client'

import { useState, useEffect, useRef } from 'react'
import { Comment, Video } from '@prisma/client'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { ArrowUpDown, CheckCircle2, MessageSquare } from 'lucide-react'
import MessageBubble from './MessageBubble'
import CommentInput from './CommentInput'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { formatDate } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

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
  videos?: Video[]
  isAdminView?: boolean
  companyName?: string // Studio company name
  clientCompanyName?: string | null // Client company name
  smtpConfigured?: boolean
  isPasswordProtected?: boolean
  adminUser?: any
  recipients?: Array<{ id: string; name: string | null }>
  shareToken?: string | null
  showShortcutsButton?: boolean
  allowClientDeleteComments?: boolean
  allowClientUploadFiles?: boolean
}

export default function CommentSection({
  projectId,
  projectSlug,
  comments: initialComments,
  clientName,
  clientEmail,
  isApproved,
  restrictToLatestVersion = false,
  videos = [],
  isAdminView = false,
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
}: CommentSectionProps) {
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
    authorName,
    nameSource,
    selectedRecipientId,
    namedRecipients,
    handleCommentChange,
    handleSubmitComment,
    handleReply,
    handleCancelReply,
    handleClearTimestamp,
    handleDeleteComment,
    setAuthorName,
    handleNameSourceChange,
    attachedFiles,
    onFileSelect,
    onRemoveFile,
    clientUploadQuota,
    refreshClientUploadQuota,
  } = useCommentManagement({
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

  // Auto-scroll to latest comment (like messaging apps)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [localComments, setLocalComments] = useState<CommentWithReplies[]>(initialComments)

  const [commentSortMode, setCommentSortMode] = useState<'timecode' | 'date'>('timecode')
  const pendingScrollRef = useRef<{ commentId: string; parentId: string | null } | null>(null)
  const pendingScrollAttemptsRef = useRef(0)

  const canClientDelete = allowClientDeleteComments && !isAdminView

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

  // Fetch comments function (only used for event-triggered updates)
  const fetchComments = async () => {
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
    } catch (error) {
      // Silent fail - keep showing existing comments
    }
  }

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
  }, [projectId])

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
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
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

    // For date sorting, show new top-level messages at the bottom
    if (commentSortMode === 'date' && !isReply) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
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

  const replyingToComment = mergedComments.find(c => c.id === replyingToCommentId) || null

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
      // Brief highlight effect
      element.style.transition = 'background-color 0.3s'
      element.style.backgroundColor = 'rgba(59, 130, 246, 0.1)'
      setTimeout(() => {
        element.style.backgroundColor = 'transparent'
      }, 1000)
    }
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

  return (
    <Card className="bg-card border border-border flex flex-col h-auto lg:h-full max-h-[75vh] rounded-lg overflow-hidden" data-comment-section>
      <CardHeader className="border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-foreground flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Feedback
          </CardTitle>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCommentSortMode(current => (current === 'timecode' ? 'date' : 'timecode'))}
            className="text-muted-foreground hover:text-foreground -mr-2"
            title={commentSortMode === 'timecode' ? 'Sorting by timecode' : 'Sorting by comment date'}
          >
            <ArrowUpDown className="w-4 h-4" />
            <span className="ml-2 hidden sm:inline">
              {commentSortMode === 'timecode' ? 'Sorting by timecode' : 'Sorting by comment date'}
            </span>
          </Button>
        </div>
        {selectedVideoId && currentVideo && !isAdminView && (
          <p className="text-xs text-muted-foreground mt-1">
            {commentsDisabled
              ? 'Watching approved version'
              : `Currently viewing: ${currentVideo.versionLabel}`}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex-1 flex flex-col p-0 overflow-hidden min-h-0">
        {/* Approval Status Banner */}
        {commentsDisabled && (
          <div className="bg-success-visible border-b-2 border-success-visible p-4 flex-shrink-0">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-success flex-shrink-0" />
              <div>
                <h3 className="text-foreground font-medium">
                  {isApproved ? 'Project Approved' : 'Video Approved'}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isApproved
                    ? 'The final version is ready for download without watermarks.'
                    : approvedVideo
                    ? `${approvedVideo.versionLabel} of this video has been approved and is ready for download.`
                    : 'A version of this video has been approved and is ready for download.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Messages Area - Threaded Conversations */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0 bg-gray-50 dark:bg-gray-900/30">
          {sortedComments.length === 0 ? (
            <div className="text-center py-12">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No messages yet. Start the conversation!</p>
            </div>
          ) : (
            <>
              {sortedComments.map((comment) => {
                const isViewerMessage = isAdminView ? comment.isInternal : !comment.isInternal
                const hasReplies = comment.replies && comment.replies.length > 0
                const repliesExpanded = expandedReplies[comment.id] ?? true // Default to expanded
                const canDeleteParent = isAdminView || (canClientDelete && !comment.isInternal)
                const allowAnyReplyDelete = isAdminView || canClientDelete
                const canDeleteReply = (reply: Comment) => isAdminView || (canClientDelete && !reply.isInternal)

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
                        parentComment={null}
                        onReply={() => handleReply(comment.id, comment.videoId)}
                        onSeekToTimestamp={handleSeekToTimestamp}
                        onDelete={canDeleteParent ? () => handleDeleteComment(comment.id) : undefined}
                        onScrollToComment={handleScrollToComment}
                        formatMessageTime={formatMessageTime}
                        commentsDisabled={commentsDisabled}
                        isViewerMessage={isViewerMessage}
                        onDownloadCommentFile={(shareToken || isAdminView) ? handleDownloadCommentFile : undefined}
                      />
                    ) : (
                      // Has replies - render extended bubble
                      <MessageBubble
                        comment={comment}
                        isReply={false}
                        isStudio={comment.isInternal}
                        studioCompanyName={companyName}
                        clientCompanyName={clientCompanyName}
                        parentComment={null}
                        onReply={() => handleReply(comment.id, comment.videoId)}
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

        {/* Input Area */}
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
          replyingToComment={replyingToComment}
          onCancelReply={handleCancelReply}
          showAuthorInput={!isAdminView && isPasswordProtected}
          authorName={authorName}
          onAuthorNameChange={setAuthorName}
          namedRecipients={namedRecipients}
          nameSource={nameSource}
          selectedRecipientId={selectedRecipientId}
          onNameSourceChange={handleNameSourceChange}
          currentVideoRestricted={currentVideoRestricted}
          restrictionMessage={restrictionMessage}
          commentsDisabled={commentsDisabled}
          showShortcutsButton={showShortcutsButton}
          onShowShortcuts={handleOpenShortcuts}
        />
      </CardContent>
    </Card>
  )
}
