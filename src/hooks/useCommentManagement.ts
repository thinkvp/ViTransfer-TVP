'use client'

import { useState, useEffect } from 'react'
import { Comment, Video } from '@prisma/client'
import { useRouter } from 'next/navigation'
import { apiPost, apiDelete } from '@/lib/api-client'
import { secondsToTimecode } from '@/lib/timecode'
import { MAX_FILES_PER_COMMENT, validateCommentFile } from '@/lib/fileUpload'
import { getAccessToken } from '@/lib/token-store'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface UseCommentManagementProps {
  projectId: string
  initialComments: CommentWithReplies[]
  videos: Video[]
  clientEmail?: string
  isPasswordProtected: boolean
  adminUser?: any
  recipients: Array<{ id: string; name: string | null; email?: string | null }>
  clientName: string
  restrictToLatestVersion: boolean
  shareToken?: string | null
  useAdminAuth?: boolean
  isInternalOverride?: boolean
  canAdminManageComments?: boolean
  companyName?: string
  allowClientDeleteComments?: boolean
  allowClientUploadFiles?: boolean
}

export function useCommentManagement({
  projectId,
  initialComments,
  videos,
  clientEmail,
  isPasswordProtected,
  adminUser = null,
  recipients,
  clientName,
  restrictToLatestVersion,
  shareToken = null,
  useAdminAuth = false,
  isInternalOverride,
  canAdminManageComments,
  companyName = 'Studio',
  allowClientDeleteComments = false,
  allowClientUploadFiles = false,
}: UseCommentManagementProps) {
  const router = useRouter()

  // State
  const [optimisticComments, setOptimisticComments] = useState<CommentWithReplies[]>([])
  const [newComment, setNewComment] = useState('')
  const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(0) // Always show; kept in sync with playback
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasAutoFilledTimestamp, setHasAutoFilledTimestamp] = useState(false)
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; size: number; file: File }>>([])
  const [pendingCommentId, setPendingCommentId] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploadStatusText, setUploadStatusText] = useState<string>('')

  const [clientUploadQuota, setClientUploadQuota] = useState<{ usedBytes: number; limitMB: number } | null>(null)

  const fetchClientUploadQuota = async (): Promise<{ usedBytes: number; limitMB: number } | null> => {
    try {
      const token = shareToken ? shareToken : (useAdminAuth ? getAccessToken() : null)
      const response = await fetch(`/api/projects/${projectId}/client-upload-quota`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json()
      const quota = {
        usedBytes: Number(data.usedBytes || 0),
        limitMB: Number(data.limitMB || 0),
      }
      setClientUploadQuota(quota)
      return quota
    } catch {
      return null
    }
  }

  const refreshClientUploadQuota = async () => {
    await fetchClientUploadQuota()
  }

  useEffect(() => {
    if (allowClientUploadFiles) {
      refreshClientUploadQuota()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, allowClientUploadFiles])

  const uploadCommentFileWithProgress = (
    commentId: string,
    file: File,
    onProgress: (loaded: number, total: number) => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/comments/${commentId}/files`)

      const token = shareToken ? shareToken : (useAdminAuth ? getAccessToken() : null)
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(e.loaded, e.total)
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
          return
        }

        try {
          const parsed = JSON.parse(xhr.responseText || '{}')
          reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status})`))
        } catch {
          reject(new Error(`Upload failed (HTTP ${xhr.status})`))
        }
      }

      xhr.onerror = () => reject(new Error('Upload failed'))

      const formData = new FormData()
      formData.append('file', file)
      xhr.send(formData)
    })
  }

  // Author name management
  // Load persisted name from sessionStorage (survives commenting but not page refresh)
  const storageKey = `comment-name-${projectId}`
  const loadPersistedName = () => {
    if (typeof window === 'undefined') return null
    try {
      const stored = sessionStorage.getItem(storageKey)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  }

  const persistedName = loadPersistedName()
  const [authorName, setAuthorName] = useState(
    typeof persistedName?.authorName === 'string' ? persistedName.authorName : ''
  )
  const [recipientId, setRecipientId] = useState<string | null>(
    typeof persistedName?.recipientId === 'string' ? persistedName.recipientId : null
  )

  // Merge real comments with optimistic comments
  // Remove optimistic comments that have been confirmed by the server
  const activeOptimisticComments = optimisticComments.filter(oc => {
    // If this optimistic comment has a temp ID, check if a real version exists
    if (oc.id.startsWith('temp-')) {
      // Check top-level comments for matching content and similar timestamp
      const hasRealVersionTopLevel = initialComments.some(rc =>
        rc.content === oc.content &&
        rc.videoId === oc.videoId &&
        Math.abs(new Date(rc.createdAt).getTime() - new Date(oc.createdAt).getTime()) < 10000
      )

      // Check nested replies for matching content and similar timestamp
      const hasRealVersionInReplies = initialComments.some(rc =>
        rc.replies?.some((reply: any) =>
          reply.content === oc.content &&
          reply.videoId === oc.videoId &&
          Math.abs(new Date(reply.createdAt).getTime() - new Date(oc.createdAt).getTime()) < 10000
        )
      )

      return !hasRealVersionTopLevel && !hasRealVersionInReplies
    }

    // Keep non-temp comments (shouldn't happen, but safe fallback)
    return true
  })

  // Merge optimistic comments properly (nest replies under parent comments)
  const mergedComments = initialComments.map(comment => {
    // Find optimistic replies for this comment
    const optimisticReplies = activeOptimisticComments.filter(oc => oc.parentId === comment.id)

    if (optimisticReplies.length > 0) {
      return {
        ...comment,
        replies: [...(comment.replies || []), ...optimisticReplies]
      }
    }
    return comment
  })

  // Add optimistic top-level comments (no parentId)
  const optimisticTopLevel = activeOptimisticComments.filter(oc => !oc.parentId)
  const comments = [...mergedComments, ...optimisticTopLevel]

  // Auto-select first video when videos list changes (admin panel without player)
  useEffect(() => {
    if (videos.length > 0 && !selectedVideoId) {
      // Default to the latest version (order by upload/created date, then version)
      const latest = [...videos].sort((a, b) => {
        const aCreated = new Date((a as any).createdAt as any).getTime()
        const bCreated = new Date((b as any).createdAt as any).getTime()
        if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
          return bCreated - aCreated
        }
        return (b as any).version - (a as any).version
      })[0]

      if (latest?.id) {
        setSelectedVideoId(latest.id)
      } else {
        setSelectedVideoId(videos[0].id)
      }
    }
  }, [videos, selectedVideoId])

  // Sync with video player if available (share page with player)
  // Reduced from 1s to 5s to prevent UI lag during heavy interaction
  useEffect(() => {
    const syncCurrentVideo = () => {
      window.dispatchEvent(
        new CustomEvent('getSelectedVideoId', {
          detail: {
            callback: (videoId: string) => {
              if (videoId && videoId !== selectedVideoId) {
                setSelectedVideoId(videoId)
              }
            },
          },
        })
      )
    }

    syncCurrentVideo()
    const interval = setInterval(syncCurrentVideo, 5000) // Changed from 1000ms to 5000ms
    return () => clearInterval(interval)
  }, [selectedVideoId])

  // Listen for immediate video changes from VideoPlayer (for responsive comment updates)
  useEffect(() => {
    const handleVideoChange = (e: CustomEvent) => {
      const { videoId } = e.detail
      if (videoId && videoId !== selectedVideoId) {
        setSelectedVideoId(videoId)
        // When switching between different videos, the new video's playhead starts at 0:00.
        // Ensure the comment timecode resets too (VideoPlayer may not emit a time update until playback/seek).
        setSelectedTimestamp(0)
        setHasAutoFilledTimestamp(false)
      }
    }

    window.addEventListener('videoChanged', handleVideoChange as EventListener)
    return () => {
      window.removeEventListener('videoChanged', handleVideoChange as EventListener)
    }
  }, [selectedVideoId])

  // Listen for video selection from admin page (message icon clicks)
  useEffect(() => {
    const handleSelectVideo = (e: CustomEvent) => {
      const { videoId } = e.detail
      if (videoId) {
        setSelectedVideoId(videoId)
      }
    }

    window.addEventListener('selectVideoForComments', handleSelectVideo as EventListener)
    return () => {
      window.removeEventListener('selectVideoForComments', handleSelectVideo as EventListener)
    }
  }, [])

  // Listen for add comment events from video player
  useEffect(() => {
    const handleAddComment = (e: CustomEvent) => {
      setSelectedVideoId(e.detail.videoId)
      setSelectedTimestamp(e.detail.timestamp)
      setHasAutoFilledTimestamp(true)
    }

    window.addEventListener('addComment', handleAddComment as EventListener)
    return () => {
      window.removeEventListener('addComment', handleAddComment as EventListener)
    }
  }, [])

  // Keep selectedTimestamp in sync with playback (including frame-step shortcuts)
  useEffect(() => {
    const handleVideoTimeUpdated = (e: CustomEvent) => {
      const time = e.detail?.time
      const videoId = e.detail?.videoId

      if (typeof time !== 'number') return
      if (!videoId || videoId !== selectedVideoId) return
      setSelectedTimestamp(time)
    }

    window.addEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    return () => {
      window.removeEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    }
  }, [selectedVideoId])

  const handleCommentChange = (value: string) => {
    setNewComment(value)
  }

  // Submit comment
  const handleSubmitComment = async () => {
    if (!newComment.trim()) return

    // Prevent rapid-fire submissions
    if (loading) return

    if (!selectedVideoId) {
      alert('Please select a video before commenting.')
      return
    }

    if (useAdminAuth && !adminUser) {
      alert('Admin session not loaded yet. Please wait a moment and try again.')
      return
    }

    // Require a name for clients on password-protected shares
    if (!useAdminAuth && isPasswordProtected && !authorName.trim()) {
      alert('Please enter your name before commenting.')
      return
    }

    const validatedVideoId: string = selectedVideoId

    // Check if commenting on latest version only
    if (restrictToLatestVersion) {
      const latestVideoVersion = videos.length > 0 ? Math.max(...videos.map(v => v.version)) : null
      const selectedVideo = videos.find(v => v.id === validatedVideoId)
      if (selectedVideo && selectedVideo.version !== latestVideoVersion) {
        alert('Comments are only allowed on the latest version of this project.')
        return
      }
    }

    // Pre-check project-level upload allocation for clients (avoid posting the comment then failing uploads)
    if (!useAdminAuth && allowClientUploadFiles && attachedFiles.length > 0) {
      const quota = await fetchClientUploadQuota()
      if (quota && quota.limitMB > 0) {
        const limitBytes = quota.limitMB * 1024 * 1024
        const pendingBytes = attachedFiles.reduce((sum, f) => sum + (f.file?.size || 0), 0)
        if (quota.usedBytes + pendingBytes > limitBytes) {
          const remainingBytes = Math.max(0, limitBytes - quota.usedBytes)
          const remainingMB = Math.floor(remainingBytes / (1024 * 1024))
          alert(`Upload limit exceeded. Remaining allowance: ${remainingMB}MB.`)
          return
        }
      }
    }

    setLoading(true)
    setUploadProgress(attachedFiles.length > 0 ? 0 : null)
    setUploadStatusText(attachedFiles.length > 0 ? 'Uploading...' : 'Sending...')

    // OPTIMISTIC UPDATE
    const isAdminContext = useAdminAuth || !!adminUser
    const isInternalComment = typeof isInternalOverride === 'boolean' ? isInternalOverride : isAdminContext

    if (isAdminContext && canAdminManageComments === false) {
      alert('You do not have permission to make or delete comments on the Share Page.')
      return
    }
    // Convert seconds to timecode for API and storage
    const selectedVideo = videos.find(v => v.id === validatedVideoId)
    const fps = selectedVideo?.fps || 24 // Default to 24fps if not available
    const timecode = selectedTimestamp !== null ? secondsToTimecode(selectedTimestamp, fps) : '00:00:00:00'

    const optimisticComment: CommentWithReplies = {
      id: `temp-${Date.now()}`,
      projectId,
      videoId: validatedVideoId,
      videoVersion: videos.find(v => v.id === validatedVideoId)?.version || null,
      timecode,
      content: newComment,
      authorName: isAdminContext
        ? (adminUser!.name || 'Admin')
        : (isPasswordProtected ? authorName : 'Client'),
      authorEmail: isAdminContext ? null : (clientEmail || null),
      isInternal: isInternalComment,
      recipientId: isAdminContext ? null : (recipientId || null),
      displayColorSnapshot: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: replyingToCommentId,
      userId: null,
      replies: [],
    }

    setOptimisticComments(prev => [...prev, optimisticComment])

    // Snapshot current form state; keep UI visible until uploads finish
    const commentContent = newComment
    const commentTimestamp = selectedTimestamp
    const commentVideoId = validatedVideoId
    const commentParentId = replyingToCommentId
    const filesToUpload = attachedFiles

    try {
      // Convert timestamp to timecode for API
      const commentVideo = videos.find(v => v.id === commentVideoId)
      const fps = commentVideo?.fps || 24
      const commentTimecode = commentTimestamp !== null ? secondsToTimecode(commentTimestamp, fps) : '00:00:00:00'

      // Build request body - only include fields with values
      const requestBody: any = {
        projectId,
        videoId: commentVideoId,
        timecode: commentTimecode,
        content: commentContent,
        isInternal: isInternalComment,
      }

      // Add optional fields only if they have values
      if (isAdminContext) {
        requestBody.authorName = adminUser!.name || 'Admin'
      } else {
        if (authorName) requestBody.authorName = authorName
        if (clientEmail) requestBody.authorEmail = clientEmail
        if (recipientId) requestBody.recipientId = recipientId
      }

      // Only include parentId if replying (not null)
      if (commentParentId) {
        requestBody.parentId = commentParentId
      }

      const updatedComments = await (shareToken
        ? fetch('/api/comments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
            },
            body: JSON.stringify(requestBody),
          }).then(async response => {
            if (!response.ok) {
              const err = await response.json().catch(() => ({}))
              throw new Error(err.error || 'Failed to submit comment')
            }
            return response.json()
          })
        : useAdminAuth
          ? apiPost('/api/comments', requestBody)
          : Promise.reject(new Error('Authentication required to submit comment')))

      // Clear the optimistic comment immediately since we have real data
      setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))

      // Find the newly created comment id
      let newCommentId: string | null = null
      if (commentParentId) {
        const parentComment = updatedComments.find((c: any) => c.id === commentParentId)
        if (parentComment?.replies && parentComment.replies.length > 0) {
          newCommentId = parentComment.replies[parentComment.replies.length - 1].id
        }
      } else {
        if (updatedComments.length > 0) {
          newCommentId = updatedComments[updatedComments.length - 1].id
        }
      }

      // Upload attached files with progress (if any)
      if (filesToUpload.length > 0 && newCommentId) {
        setUploadStatusText('Uploading...')

        const totalBytes = filesToUpload.reduce((sum, f) => sum + (f.file?.size || 0), 0)
        let completedBytes = 0

        for (const file of filesToUpload) {
          const currentTotal = file.file.size
          setUploadStatusText(`Uploading ${file.name}...`)

          await uploadCommentFileWithProgress(newCommentId, file.file, (loaded) => {
            const overall = totalBytes > 0 ? (completedBytes + Math.min(loaded, currentTotal)) / totalBytes : 0
            setUploadProgress(Math.max(0, Math.min(100, Math.round(overall * 100))))
          })

          completedBytes += currentTotal
          const overall = totalBytes > 0 ? completedBytes / totalBytes : 1
          setUploadProgress(Math.max(0, Math.min(100, Math.round(overall * 100))))
        }

        // Refresh quota after successful uploads
        refreshClientUploadQuota()
      }

      // Refresh comments so attachments render immediately
      let commentsForUi = updatedComments
      if (filesToUpload.length > 0) {
        try {
          const response = shareToken
            ? await fetch(`/api/comments?projectId=${projectId}`, {
                headers: { Authorization: `Bearer ${shareToken}` },
              })
            : useAdminAuth
              ? await fetch(`/api/comments?projectId=${projectId}`)
              : null

          if (response?.ok) {
            commentsForUi = await response.json()
          }
        } catch (err) {
          console.error('Failed to refresh comments after file upload:', err)
        }
      }

      window.dispatchEvent(new CustomEvent('commentPosted', {
        detail: {
          comments: commentsForUi,
          newCommentId,
          parentId: commentParentId || null,
        }
      }))

      // Clear input only after send + uploads complete
      setNewComment('')
      setHasAutoFilledTimestamp(false)
      setReplyingToCommentId(null)
      setAttachedFiles([])
      setPendingCommentId(null)
      setUploadStatusText('')
      setUploadProgress(null)

      router.refresh()
    } catch (error) {
      // Handle synchronous errors only
      setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))
      setUploadStatusText('')
      setUploadProgress(null)
      setNewComment(commentContent)
      setSelectedTimestamp(commentTimestamp)
      setSelectedVideoId(commentVideoId)
      alert(`Failed to submit comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      // Clear loading only after send/upload finishes
      setLoading(false)
    }
  }

  const handleReply = (commentId: string, videoId: string) => {
    setReplyingToCommentId(commentId)
    setSelectedVideoId(videoId)
  }

  const handleCancelReply = () => {
    setReplyingToCommentId(null)
  }

  const handleClearTimestamp = () => {
    setSelectedTimestamp(null)
    setSelectedVideoId(null)
    setHasAutoFilledTimestamp(false)
  }

  const findCommentById = (commentId: string): CommentWithReplies | null => {
    for (const comment of comments) {
      if (comment.id === commentId) return comment
      const matchingReply = comment.replies?.find(reply => reply.id === commentId)
      if (matchingReply) return matchingReply as CommentWithReplies
    }
    return null
  }

  const handleDeleteComment = async (commentId: string) => {
    const isAdminContext = useAdminAuth || !!adminUser
    if (isAdminContext && canAdminManageComments === false) {
      alert('You do not have permission to make or delete comments on the Share Page.')
      return
    }
    const targetComment = findCommentById(commentId)

    if (!isAdminContext) {
      if (!allowClientDeleteComments) {
        alert('Comment deletion is disabled for this project.')
        return
      }

      if (!targetComment) {
        alert('Unable to find that comment. Please refresh and try again.')
        return
      }

      if (targetComment.isInternal) {
        alert('Only client comments can be deleted.')
        return
      }

      if (!shareToken) {
        alert('Authentication required to delete comments.')
        return
      }
    }

    if (!confirm('Are you sure you want to delete this comment? This action cannot be undone.')) {
      return
    }

    try {
      if (shareToken) {
        const response = await fetch(`/api/comments/${commentId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${shareToken}`,
          },
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to delete comment')
        }
      } else if (useAdminAuth) {
        await apiDelete(`/api/comments/${commentId}`)
      } else {
        throw new Error('Authentication required to delete comment')
      }

      // Trigger immediate re-fetch via window event (CommentSection polling will pick it up)
      window.dispatchEvent(new CustomEvent('commentDeleted'))
    } catch (error) {
      alert(`Failed to delete comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Wrapper for setAuthorName that also persists to sessionStorage
  const handleAuthorNameChange = (name: string) => {
    setAuthorName(name)
    setRecipientId(null)

    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ authorName: name, recipientId: null }))
    } catch {
      // Ignore storage errors
    }
  }

  const handleRecipientSelection = (name: string, selectedRecipientId: string | null) => {
    setAuthorName(name)
    setRecipientId(selectedRecipientId)

    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ authorName: name, recipientId: selectedRecipientId }))
    } catch {
      // Ignore storage errors
    }
  }

  // Get FPS of currently selected video
  const selectedVideo = videos.find(v => v.id === selectedVideoId)
  const selectedVideoFps = selectedVideo?.fps || 24

  // Handle file selection - store in state; upload happens after comment creation
  const onFileSelect = async (files: File[]) => {
    if (!files || files.length === 0) return

    if (attachedFiles.length + files.length > MAX_FILES_PER_COMMENT) {
      throw new Error(`You can attach up to ${MAX_FILES_PER_COMMENT} files per comment.`)
    }

    const validated = files.map((file) => {
      const validation = validateCommentFile(file.name, file.type, file.size)
      if (!validation.valid) {
        throw new Error(validation.error || 'File is not allowed')
      }
      return { name: file.name, size: file.size, file }
    })

    setAttachedFiles((prev) => [...prev, ...validated])
  }

  // Remove one attached file by index
  const onRemoveFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const replyingToComment = comments.find((c) => c.id === replyingToCommentId) || null

  return {
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
    recipientId,
    handleCommentChange,
    handleSubmitComment,
    handleReply,
    handleCancelReply,
    handleClearTimestamp,
    handleDeleteComment,
    setAuthorName: handleAuthorNameChange,
    setRecipient: handleRecipientSelection,
    attachedFiles,
    onFileSelect,
    onRemoveFile,
    clientUploadQuota,
    refreshClientUploadQuota,
  }
}
