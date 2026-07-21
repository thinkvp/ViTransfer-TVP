'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Comment } from '@prisma/client'
import type { Video } from '@/types/video'
import { useRouter } from 'next/navigation'
import { apiFetch, apiPost, apiDelete, apiPatch } from '@/lib/api-client'
import { secondsToTimecode } from '@/lib/timecode'
import { MAX_FILES_PER_COMMENT, validateCommentFile } from '@/lib/fileUpload'
import { getAccessToken } from '@/lib/token-store'
import { isS3Mode } from '@/lib/storage-provider-client'
import { toast } from 'sonner'

type CommentWithReplies = Comment & {
  replies?: Comment[]
  authorType?: 'USER' | 'RECIPIENT' | 'ANONYMOUS'
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

type AttachedCommentFile = {
  name: string
  size: number
  file: File
}

type VoiceNoteDraft = {
  file: File
  durationSeconds: number
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
  const [selectedEndTimestamp, setSelectedEndTimestamp] = useState<number | null>(null) // Range end; null = point comment
  const [commentDraftAnchorTimestamp, setCommentDraftAnchorTimestamp] = useState<number | null>(null)
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasAutoFilledTimestamp, setHasAutoFilledTimestamp] = useState(false)
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<AttachedCommentFile[]>([])
  const [voiceNoteDraft, setVoiceNoteDraft] = useState<VoiceNoteDraft | null>(null)
  const [pendingCommentId, setPendingCommentId] = useState<string | null>(null)
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploadStatusText, setUploadStatusText] = useState<string>('')
  const previousSelectedVideoIdRef = useRef<string | null>(null)
  const commentDraftAnchorTimestampRef = useRef<number | null>(null)
  // True when the user has typed an exact in/out time in the editor. While
  // pinned, playback must not drift the point timestamp or clear the range.
  // The ref is read synchronously in event handlers; the state drives the
  // Reset affordance so the user can return to playhead-following.
  const selectionPinnedRef = useRef(false)
  const [selectionPinned, setSelectionPinned] = useState(false)
  const setPinned = useCallback((value: boolean) => {
    selectionPinnedRef.current = value
    setSelectionPinned(value)
  }, [])

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

  const uploadCommentFileWithProgress = async (
    commentId: string,
    file: File,
    onProgress: (loaded: number, total: number) => void,
    uploadIntent: 'attachment' | 'voice-note' = 'attachment'
  ): Promise<void> => {
    if (await isS3Mode()) {
      return uploadCommentFileS3(commentId, file, onProgress, uploadIntent)
    }
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
      if (uploadIntent === 'voice-note') {
        formData.append('uploadIntent', 'voice-note')
      }
      xhr.send(formData)
    })
  }

  /**
   * Browser-direct S3 multipart upload for comment files.
   * Tracks real upload progress to S3 via XHR upload events.
   */
  const uploadCommentFileS3 = async (
    commentId: string,
    file: File,
    onProgress: (loaded: number, total: number) => void,
    uploadIntent: 'attachment' | 'voice-note' = 'attachment'
  ): Promise<void> => {
    const token = shareToken ? shareToken : (useAdminAuth ? getAccessToken() : null)

    const presignHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) presignHeaders['Authorization'] = `Bearer ${token}`

    const presignRes = await fetch(`/api/comments/${commentId}/files/s3/presign`, {
      method: 'POST',
      headers: presignHeaders,
      body: JSON.stringify({
        fileSize: file.size,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        uploadIntent,
      }),
    })

    if (!presignRes.ok) {
      const err = await presignRes.json().catch(() => ({ error: 'Presign failed' }))
      throw new Error(err.error ?? 'Presign failed')
    }

    const { uploadId, key, parts, partSize } = await presignRes.json()

    const totalBytes = file.size
    let totalSentBytes = 0
    const completedParts: Array<{ partNumber: number; etag: string }> = new Array(parts.length)

    // Upload parts sequentially (comment files are typically single-part or small)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const start = i * partSize
      const end = Math.min(start + partSize, file.size)
      const slice = file.slice(start, end)
      const partBytes = end - start

      const etag = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', part.url)
        let lastLoaded = 0
        xhr.upload.addEventListener('progress', (e) => {
          const delta = e.loaded - lastLoaded
          if (delta <= 0) return
          lastLoaded = e.loaded
          totalSentBytes = Math.min(totalSentBytes + delta, totalBytes)
          onProgress(totalSentBytes, totalBytes)
        })
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const trailingDelta = partBytes - lastLoaded
            if (trailingDelta > 0) {
              totalSentBytes = Math.min(totalSentBytes + trailingDelta, totalBytes)
              onProgress(totalSentBytes, totalBytes)
            }
            const etag = xhr.getResponseHeader('ETag') ?? xhr.getResponseHeader('etag')
            etag ? resolve(etag) : reject(new Error('No ETag in response'))
          } else {
            reject(new Error(`Part upload failed: ${xhr.status}`))
          }
        })
        xhr.addEventListener('error', () => reject(new Error('Network error during part upload')))
        xhr.send(slice)
      })

      completedParts[i] = { partNumber: part.partNumber, etag }
    }

    // Complete the multipart upload and create DB record
    const completeHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) completeHeaders['Authorization'] = `Bearer ${token}`

    const completeRes = await fetch(`/api/comments/${commentId}/files/s3/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({
        uploadId,
        key,
        parts: completedParts,
        fileSize: file.size,
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
        uploadIntent,
      }),
    })

    if (!completeRes.ok) {
      // Attempt best-effort abort on failure
      fetch(`/api/comments/${commentId}/files/s3/abort`, {
        method: 'POST',
        headers: completeHeaders,
        body: JSON.stringify({ uploadId, key }),
      }).catch(() => undefined)
      const err = await completeRes.json().catch(() => ({ error: 'Complete failed' }))
      throw new Error(err.error ?? 'Complete failed')
    }
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
        setCommentDraftAnchorTimestamp(null)
        commentDraftAnchorTimestampRef.current = null
        setPinned(false)
        setHasAutoFilledTimestamp(false)
      }
    }

    window.addEventListener('videoChanged', handleVideoChange as EventListener)
    return () => {
      window.removeEventListener('videoChanged', handleVideoChange as EventListener)
    }
  }, [selectedVideoId, setPinned])

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
      setPinned(false)
      const anchor = typeof e.detail.timestamp === 'number' ? e.detail.timestamp : 0
      setCommentDraftAnchorTimestamp(anchor)
      commentDraftAnchorTimestampRef.current = anchor
      setHasAutoFilledTimestamp(true)
    }

    window.addEventListener('addComment', handleAddComment as EventListener)
    return () => {
      window.removeEventListener('addComment', handleAddComment as EventListener)
    }
  }, [setPinned])

  // Listen for range updates from VideoPlayer timeline handles
  useEffect(() => {
    const handleRangeChanged = (e: CustomEvent) => {
      const { start, end } = e.detail || {}
      if (typeof start === 'number') {
        setSelectedTimestamp(start)
        if (commentDraftAnchorTimestampRef.current === null) {
          commentDraftAnchorTimestampRef.current = start
          setCommentDraftAnchorTimestamp(start)
        }
      }
      // Only show a range when handles are far enough apart (end is only sent when >= 0.5s separation).
      setSelectedEndTimestamp(typeof end === 'number' ? end : null)
    }
    const handleRangeDeactivated = () => {
      setSelectedEndTimestamp(null)
    }

    window.addEventListener('commentRangeChanged', handleRangeChanged as EventListener)
    window.addEventListener('deactivateCommentRange', handleRangeDeactivated)
    return () => {
      window.removeEventListener('commentRangeChanged', handleRangeChanged as EventListener)
      window.removeEventListener('deactivateCommentRange', handleRangeDeactivated)
    }
  }, [])

  // Keep selectedTimestamp in sync with playback (including frame-step shortcuts)
  useEffect(() => {
    const handleVideoTimeUpdated = (e: CustomEvent) => {
      const time = e.detail?.time
      const videoId = e.detail?.videoId

      if (typeof time !== 'number') return
      if (!videoId || videoId !== selectedVideoId) return
      // Keep the unsaved range display stable while a range is active.
      if (selectedEndTimestamp !== null) return
      // The user typed an exact time in the editor — don't let playback drift it.
      if (selectionPinnedRef.current) return
      setSelectedTimestamp(time)
    }

    window.addEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    return () => {
      window.removeEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    }
  }, [selectedEndTimestamp, selectedVideoId])

  useEffect(() => {
    const previousSelectedVideoId = previousSelectedVideoIdRef.current

    if (previousSelectedVideoId && previousSelectedVideoId !== selectedVideoId) {
      setReplyingToCommentId(null)
    }

    previousSelectedVideoIdRef.current = selectedVideoId
  }, [selectedVideoId])

  const handleCommentChange = (value: string) => {
    setNewComment(value)
  }

  const resetDraft = useCallback(() => {
    setNewComment('')
    setHasAutoFilledTimestamp(false)
    setReplyingToCommentId(null)
    setAttachedFiles([])
    setVoiceNoteDraft(null)
    setPendingCommentId(null)
    setUploadStatusText('')
    setUploadProgress(null)
    setSelectedEndTimestamp(null)
    setCommentDraftAnchorTimestamp(null)
    commentDraftAnchorTimestampRef.current = null
    setPinned(false)
    window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
  }, [setPinned])

  const hasUnsentComment = Boolean(newComment.trim() || attachedFiles.length > 0 || voiceNoteDraft)

  useEffect(() => {
    const handlePlaybackStarted = () => {
      // If they resumed playback without drafting anything, clear the temporary range overlay.
      // Exception: if the user has explicitly selected an in/out range, preserve it so they
      // can play through the segment and still post a range-scoped comment.
      if (!hasUnsentComment && selectedEndTimestamp === null && !selectionPinnedRef.current) {
        setSelectedEndTimestamp(null)
        window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
      }
    }

    window.addEventListener('videoPlaybackStarted', handlePlaybackStarted)
    return () => {
      window.removeEventListener('videoPlaybackStarted', handlePlaybackStarted)
    }
  }, [hasUnsentComment, selectedEndTimestamp])

  // Submit comment
  const handleSubmitComment = async () => {
    if (!newComment.trim() && !voiceNoteDraft) return

    // Prevent rapid-fire submissions
    if (loading) return

    if (!selectedVideoId) {
      toast.error('Please select a video before commenting.')
      return
    }

    if (useAdminAuth && !adminUser) {
      toast.error('Admin session not loaded yet. Please wait a moment and try again.')
      return
    }

    // Require a name for clients on password-protected shares
    if (!useAdminAuth && isPasswordProtected && !authorName.trim()) {
      toast.error('Please enter your name before commenting.')
      return
    }

    const validatedVideoId: string = selectedVideoId

    // Check if commenting on latest version only
    if (restrictToLatestVersion) {
      const latestVideoVersion = videos.length > 0 ? Math.max(...videos.map(v => v.version)) : null
      const selectedVideo = videos.find(v => v.id === validatedVideoId)
      if (selectedVideo && selectedVideo.version !== latestVideoVersion) {
        toast.error('Comments are only allowed on the latest version of this project.')
        return
      }
    }

    // Pre-check project-level upload allocation for clients (avoid posting the comment then failing uploads)
    if (!useAdminAuth && (attachedFiles.length > 0 || voiceNoteDraft)) {
      const quota = await fetchClientUploadQuota()
      if (quota && quota.limitMB > 0) {
        const limitBytes = quota.limitMB * 1024 * 1024
        const pendingBytes = attachedFiles.reduce((sum, f) => sum + (f.file?.size || 0), 0)
          + (voiceNoteDraft?.file?.size || 0)
        if (quota.usedBytes + pendingBytes > limitBytes) {
          const remainingBytes = Math.max(0, limitBytes - quota.usedBytes)
          const remainingMB = Math.floor(remainingBytes / (1024 * 1024))
          toast.error(`Upload limit exceeded. Remaining allowance: ${remainingMB}MB.`)
          return
        }
      }
    }

    setLoading(true)
  const hasAnyUploads = attachedFiles.length > 0 || Boolean(voiceNoteDraft)
  setUploadProgress(hasAnyUploads ? 0 : null)
  setUploadStatusText(hasAnyUploads ? 'Uploading...' : 'Sending...')

    // OPTIMISTIC UPDATE
    const isAdminContext = useAdminAuth || !!adminUser
    const isInternalComment = typeof isInternalOverride === 'boolean' ? isInternalOverride : isAdminContext

    if (isAdminContext && canAdminManageComments === false) {
      toast.error('You do not have permission to make or delete comments on the Share Page.')
      return
    }
    // Convert seconds to timecode for API and storage
    const selectedVideo = videos.find(v => v.id === validatedVideoId)
    const fps = selectedVideo?.fps || 24 // Default to 24fps if not available
    const timecode = selectedTimestamp !== null ? secondsToTimecode(selectedTimestamp, fps) : '00:00:00:00'

    const rawCommentInput = newComment
    const finalCommentContent = rawCommentInput.trim() ? rawCommentInput : '*Voice Note*'

    const optimisticComment: CommentWithReplies = {
      id: `temp-${Date.now()}`,
      projectId,
      videoId: validatedVideoId,
      videoVersion: videos.find(v => v.id === validatedVideoId)?.version || null,
      timecode,
      content: finalCommentContent,
      authorName: isAdminContext
        ? (adminUser!.name || 'Admin')
        : (isPasswordProtected ? authorName : 'Client'),
      authorEmail: isAdminContext ? null : (clientEmail || null),
      isInternal: isInternalComment,
      recipientId: isAdminContext ? null : (recipientId || null),
      authorType: isAdminContext ? 'USER' : (recipientId ? 'RECIPIENT' : 'ANONYMOUS'),
      displayColorSnapshot: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: replyingToCommentId,
      userId: null,
      timecodeEnd: null,
      resolvedAt: null,
      resolvedById: null,
      lockedAt: null,
      replies: [],
    }

    setOptimisticComments(prev => [...prev, optimisticComment])

    // Snapshot current form state; keep UI visible until uploads finish
    const commentContent = finalCommentContent
    const commentTimestamp = selectedTimestamp
    const commentVideoId = validatedVideoId
    const commentParentId = replyingToCommentId
    const filesToUpload: Array<AttachedCommentFile & { uploadIntent: 'attachment' | 'voice-note' }> = [
      ...attachedFiles.map((file) => ({ ...file, uploadIntent: 'attachment' as const })),
      ...(voiceNoteDraft
        ? [{
            name: voiceNoteDraft.file.name,
            size: voiceNoteDraft.file.size,
            file: voiceNoteDraft.file,
            uploadIntent: 'voice-note' as const,
          }]
        : []),
    ]

    try {
      // Convert timestamp to timecode for API
      const commentVideo = videos.find(v => v.id === commentVideoId)
      const fps = commentVideo?.fps || 24
      const commentTimecode = commentTimestamp !== null ? secondsToTimecode(commentTimestamp, fps) : '00:00:00:00'

      // Build request body - only include fields with values
      const commentEndTimecode = selectedEndTimestamp !== null && !commentParentId
        ? secondsToTimecode(selectedEndTimestamp, fps)
        : undefined

      const requestBody: any = {
        projectId,
        videoId: commentVideoId,
        timecode: commentTimecode,
        ...(commentEndTimecode ? { timecodeEnd: commentEndTimecode } : {}),
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
          setUploadStatusText(
            file.uploadIntent === 'voice-note'
              ? 'Uploading voice note...'
              : `Uploading ${file.name}...`
          )

          await uploadCommentFileWithProgress(newCommentId, file.file, (loaded) => {
            const overall = totalBytes > 0 ? (completedBytes + Math.min(loaded, currentTotal)) / totalBytes : 0
            setUploadProgress(Math.max(0, Math.min(100, Math.round(overall * 100))))
          }, file.uploadIntent)

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
                cache: 'no-store',
              })
            : useAdminAuth
              ? await apiFetch(`/api/comments?projectId=${projectId}`, { cache: 'no-store' })
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
      resetDraft()

      router.refresh()
    } catch (error) {
      // Handle synchronous errors only
      setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))
      setUploadStatusText('')
      setUploadProgress(null)
      setNewComment(rawCommentInput)
      setSelectedTimestamp(commentTimestamp)
      setSelectedVideoId(commentVideoId)
      toast.error(`Failed to submit comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      // Clear loading only after send/upload finishes
      setLoading(false)
    }
  }

  const handleReply = (commentId: string, videoId: string) => {
    setReplyingToCommentId(commentId)
    setSelectedVideoId(videoId)
    // A reply threads under its parent and has no timeline position, so drop any
    // active comment-range marker/selection (it doesn't apply to a reply).
    setSelectedEndTimestamp(null)
    setPinned(false)
    window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
  }

  const handleCancelReply = () => {
    setReplyingToCommentId(null)
  }

  const syncTimestampToCurrentPlayhead = () => {
    window.dispatchEvent(
      new CustomEvent('getCurrentTime', {
        detail: {
          callback: (time: number, videoId: string | null) => {
            if (typeof time === 'number' && Number.isFinite(time)) {
              setSelectedTimestamp(time)
            }
            if (videoId) {
              setSelectedVideoId(videoId)
            }
          },
        },
      })
    )
  }

  const handleClearTimestamp = () => {
    setSelectedEndTimestamp(null)
    setPinned(false)
    // Reset should clear the draft timeline marker and follow the current playhead.
    window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
    syncTimestampToCurrentPlayhead()
  }

  // Set the comment in/out times directly (driven by the time-editor modal).
  // `endSeconds === null` means a point comment (in === out). Also moves the
  // timeline marker/handles so the change is visible before the comment is sent.
  const handleSetCommentTimes = useCallback((startSeconds: number, endSeconds: number | null) => {
    const start = Math.max(0, startSeconds)
    const end = endSeconds === null ? null : Math.max(start, endSeconds)
    setPinned(true)
    setSelectedTimestamp(start)
    setSelectedEndTimestamp(end)
    if (commentDraftAnchorTimestampRef.current === null) {
      commentDraftAnchorTimestampRef.current = start
      setCommentDraftAnchorTimestamp(start)
    }
    window.dispatchEvent(
      new CustomEvent('setCommentRange', { detail: { start, end } })
    )
  }, [setPinned])

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
      toast.error('You do not have permission to make or delete comments on the Share Page.')
      return
    }
    const targetComment = findCommentById(commentId)

    if (!isAdminContext) {
      if (!allowClientDeleteComments) {
        toast.error('Comment deletion is disabled for this project.')
        return
      }

      if (!targetComment) {
        toast.error('Unable to find that comment. Please refresh and try again.')
        return
      }

      const canClientDeleteThis =
        targetComment?.authorType
          ? targetComment.authorType === 'RECIPIENT'
          : !targetComment.isInternal

      if (!canClientDeleteThis) {
        toast.error('Only recipient comments can be deleted.')
        return
      }

      // Clients cannot delete comments on an approved video.
      const commentVideo = videos.find(v => v.id === targetComment.videoId)
      if (commentVideo?.approved) {
        toast.error('Comments cannot be deleted after the video has been approved.')
        return
      }

      if (!shareToken) {
        toast.error('Authentication required to delete comments.')
        return
      }
    }

    setPendingDeleteCommentId(commentId)
  }

  const confirmDeleteComment = async () => {
    const commentId = pendingDeleteCommentId
    if (!commentId) return
    setPendingDeleteCommentId(null)

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
      toast.error(`Failed to delete comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Save an edited comment. Returns true on success so the caller can close the editor.
  // The PATCH response is the full sanitized comment list, so we reuse the commentPosted
  // event (without newCommentId — no auto-scroll) to update page + section state at once.
  const handleEditComment = async (commentId: string, content: string): Promise<boolean> => {
    const trimmed = content.trim()
    if (!trimmed) {
      toast.error('Comment cannot be empty.')
      return false
    }

    // Clients cannot edit comments on an approved video.
    if (!useAdminAuth && !adminUser) {
      const targetComment = findCommentById(commentId)
      if (targetComment) {
        const commentVideo = videos.find(v => v.id === targetComment.videoId)
        if (commentVideo?.approved) {
          toast.error('Comments cannot be edited after the video has been approved.')
          return false
        }
      }
    }

    try {
      let updatedComments: any
      if (shareToken) {
        const response = await fetch(`/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${shareToken}`,
          },
          body: JSON.stringify({ content: trimmed }),
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to update comment')
        }
        updatedComments = await response.json()
      } else if (useAdminAuth) {
        updatedComments = await apiPatch(`/api/comments/${commentId}`, { content: trimmed })
      } else {
        throw new Error('Authentication required to edit comment')
      }

      window.dispatchEvent(new CustomEvent('commentPosted', {
        detail: { comments: updatedComments },
      }))
      router.refresh()
      return true
    } catch (error) {
      toast.error(`Failed to update comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return false
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

  const onVoiceNoteSelect = (file: File, durationSeconds: number) => {
    setVoiceNoteDraft({
      file,
      durationSeconds: Math.max(0, Math.min(120, Math.round(durationSeconds))),
    })
  }

  const onVoiceNoteClear = () => {
    setVoiceNoteDraft(null)
  }

  // Remove one attached file by index
  const onRemoveFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const replyingToComment = comments.find((c) => c.id === replyingToCommentId) || null

  const handleClearRange = () => {
    setSelectedEndTimestamp(null)
    setPinned(false)
    // Reset should clear the draft timeline marker and follow the current playhead.
    window.dispatchEvent(new CustomEvent('deactivateCommentRange'))
    syncTimestampToCurrentPlayhead()
  }

  const shouldShowTimestampReset =
    // A pinned point (typed exact time) always offers a way back to playhead-following.
    (selectionPinned && selectedEndTimestamp === null) ||
    (commentDraftAnchorTimestamp !== null &&
      selectedTimestamp !== null &&
      selectedEndTimestamp === null &&
      Math.abs(selectedTimestamp - commentDraftAnchorTimestamp) > 0.05)

  return {
    comments,
    newComment,
    hasUnsentComment,
    selectedTimestamp,
    selectedEndTimestamp,
    shouldShowTimestampReset,
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
    handleClearRange,
    handleSetCommentTimes,
    handleDeleteComment,
    handleEditComment,
    pendingDeleteCommentId,
    setPendingDeleteCommentId,
    confirmDeleteComment,
    resetDraft,
    setAuthorName: handleAuthorNameChange,
    setRecipient: handleRecipientSelection,
    attachedFiles,
    onFileSelect,
    onRemoveFile,
    voiceNoteDraft,
    onVoiceNoteSelect,
    onVoiceNoteClear,
    clientUploadQuota,
    refreshClientUploadQuota,
  }
}
