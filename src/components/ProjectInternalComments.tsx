
'use client'

import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { apiDelete, apiJson, apiPost } from '@/lib/api-client'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { formatDateTime } from '@/lib/utils'

type InternalComment = {
  id: string
  projectId: string
  userId: string | null
  parentId: string | null
  content: string
  createdAt: string
  updatedAt: string
  authorName: string
  displayColor: string | null
  replies: InternalComment[]
}

function formatMessageTime(dateLike: string) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return dateLike
  return formatDateTime(dateLike)
}

function stripHtmlToPlainText(html: string) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function InternalCommentBubble(props: {
  comment: InternalComment
  currentUserId: string | null
  canDeleteAny: boolean
  parentAuthorName?: string | null
  showReplyAction: boolean
  replies?: InternalComment[]
  repliesExpanded?: boolean
  onToggleReplies?: () => void
  onReply: (comment: InternalComment) => void
  onDelete: (comment: InternalComment) => void
}) {
  const {
    comment,
    currentUserId,
    canDeleteAny,
    parentAuthorName,
    showReplyAction,
    replies,
    repliesExpanded,
    onToggleReplies,
    onReply,
    onDelete,
  } = props

  const isMine = Boolean(currentUserId && comment.userId && comment.userId === currentUserId)
  const canDelete = canDeleteAny || isMine

  return (
    <div className="w-full" id={`internal-comment-${comment.id}`}>
      <div className="bg-card border border-border rounded-lg p-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <InitialsAvatar
                name={comment.authorName || 'Unknown'}
                displayColor={comment.displayColor}
                className="h-6 w-6 text-[10px]"
              />
              <div className="text-sm font-semibold text-foreground truncate">
                {comment.authorName || 'Unknown'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              {formatMessageTime(comment.createdAt)}
            </div>
            {canDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Delete"
                onClick={() => onDelete(comment)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            ) : null}
          </div>
        </div>

        {parentAuthorName ? (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CornerDownRight className="w-3 h-3" />
            <span>Reply to {parentAuthorName}</span>
          </div>
        ) : null}

        <div
          className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground"
          dangerouslySetInnerHTML={{ __html: comment.content }}
        />

        {showReplyAction ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="px-2"
              onClick={() => onReply(comment)}
            >
              Reply
            </Button>
          </div>
        ) : null}

        {Array.isArray(replies) && replies.length > 0 && onToggleReplies ? (
          <div className="mt-3 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onToggleReplies}
              className="flex items-center justify-between w-full mb-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50 hover:bg-muted/70 hover:text-foreground transition-colors"
            >
              <span>
                {replies.length} {replies.length === 1 ? 'Reply' : 'Replies'}
              </span>
              {repliesExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>

            {repliesExpanded ? (
              <div className="space-y-3">
                {replies.map((reply) => {
                  const replyIsMine = Boolean(currentUserId && reply.userId && reply.userId === currentUserId)
                  const canDeleteReply = canDeleteAny || replyIsMine

                  return (
                    <div key={reply.id} className="pl-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <CornerDownRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          <InitialsAvatar
                            name={reply.authorName || 'Unknown'}
                            displayColor={reply.displayColor}
                            className="h-5 w-5 text-[9px] ring-2"
                          />
                          <span className="text-xs font-semibold text-foreground truncate">
                            {reply.authorName || 'Unknown'}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatMessageTime(reply.createdAt)}
                          </span>
                          {canDeleteReply ? (
                            <button
                              type="button"
                              onClick={() => onDelete(reply)}
                              className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                              title="Delete reply"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div
                        className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground"
                        dangerouslySetInnerHTML={{ __html: reply.content }}
                      />
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ProjectInternalComments(props: {
  projectId: string
  currentUserId: string | null
  canMakeComments: boolean
  canDeleteAll: boolean
}) {
  const { projectId, currentUserId, canMakeComments, canDeleteAll } = props

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [comments, setComments] = useState<InternalComment[]>([])
  const [newComment, setNewComment] = useState('')
  const [replyingTo, setReplyingTo] = useState<InternalComment | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const topLevelComments = useMemo(() => {
    return (comments || []).filter((c) => !c.parentId)
  }, [comments])

  const fetchComments = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiJson<InternalComment[]>(`/api/projects/${projectId}/internal-comments`, {
        cache: 'no-store',
      })
      setComments(Array.isArray(data) ? data : [])
    } catch (e: any) {
      console.error('[INTERNAL COMMENTS] Failed to load:', e)
      setError(e?.message || 'Failed to load internal comments')
      setComments([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchComments()
  }, [fetchComments])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    setTimeout(() => {
      const el = messagesContainerRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      shouldAutoScrollRef.current = false
    }, 0)
  }, [topLevelComments.length])

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // If user is near the bottom, allow future auto-scroll (e.g., after sending).
    shouldAutoScrollRef.current = distanceFromBottom < 40
  }, [])

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedReplies((prev) => ({ ...prev, [commentId]: !(prev[commentId] ?? true) }))
  }, [])

  const replyingPreview = useMemo(() => {
    if (!replyingTo) return null
    const text = stripHtmlToPlainText(replyingTo.content)
    const short = text.length > 140 ? `${text.slice(0, 140)}…` : text
    return {
      author: replyingTo.authorName || 'Unknown',
      text: short,
    }
  }, [replyingTo])

  const submit = useCallback(async () => {
    const trimmed = newComment.trim()
    if (!trimmed) return
    if (!canMakeComments) return

    // Only allow replies to top-level comments.
    const parentId = replyingTo?.parentId ? null : replyingTo?.id || null

    setLoading(true)
    setError(null)
    try {
      shouldAutoScrollRef.current = true
      await apiPost(`/api/projects/${projectId}/internal-comments`, {
        content: trimmed,
        parentId,
      })
      setNewComment('')
      setReplyingTo(null)
      await fetchComments()
    } catch (e: any) {
      console.error('[INTERNAL COMMENTS] Failed to post:', e)
      setError(e?.message || 'Failed to post comment')
    } finally {
      setLoading(false)
    }
  }, [canMakeComments, fetchComments, newComment, projectId, replyingTo])

  const deleteOne = useCallback(
    async (comment: InternalComment) => {
      const ok = confirm('Delete this comment?')
      if (!ok) return

      setLoading(true)
      setError(null)
      try {
        await apiDelete(`/api/projects/${projectId}/internal-comments/${comment.id}`)
        if (replyingTo?.id === comment.id) setReplyingTo(null)
        await fetchComments()
      } catch (e: any) {
        console.error('[INTERNAL COMMENTS] Failed to delete:', e)
        setError(e?.message || 'Failed to delete comment')
      } finally {
        setLoading(false)
      }
    },
    [fetchComments, projectId, replyingTo?.id]
  )

  const deleteAll = useCallback(async () => {
    const ok = confirm('Delete ALL internal comments on this project? This cannot be undone.')
    if (!ok) return

    setLoading(true)
    setError(null)
    try {
      await apiDelete(`/api/projects/${projectId}/internal-comments`)
      setReplyingTo(null)
      setNewComment('')
      await fetchComments()
    } catch (e: any) {
      console.error('[INTERNAL COMMENTS] Failed to delete all:', e)
      setError(e?.message || 'Failed to delete all comments')
    } finally {
      setLoading(false)
    }
  }, [fetchComments, projectId])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Card className="bg-card border border-border">
      <CardHeader className="border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg font-semibold">Internal Comments</CardTitle>
          <div className="flex items-center gap-2">
            {canDeleteAll ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void deleteAll()}
                disabled={loading}
              >
                Delete All
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="!p-0">
        <div className="flex flex-col max-h-[50vh]">
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-auto px-4 py-4 sm:px-6 space-y-3 bg-muted/30"
          >
            {error ? (
              <div className="text-sm text-destructive">{error}</div>
            ) : null}

            {topLevelComments.length === 0 && !loading && !error ? (
              <div className="text-sm text-muted-foreground">No internal comments yet.</div>
            ) : null}

            {topLevelComments.map((comment) => {
              const replies = (comment.replies || []).map((r) => ({ ...r, replies: [] }))
              const hasReplies = replies.length > 0
              const repliesExpanded = expandedReplies[comment.id] ?? true

              return (
                <div key={comment.id} className="space-y-3">
                  <InternalCommentBubble
                    comment={comment}
                    currentUserId={currentUserId}
                    canDeleteAny={canDeleteAll}
                    showReplyAction={canMakeComments}
                    replies={hasReplies ? replies : undefined}
                    repliesExpanded={hasReplies ? repliesExpanded : undefined}
                    onToggleReplies={hasReplies ? () => toggleReplies(comment.id) : undefined}
                    onReply={(c) => {
                      if (c.parentId) return
                      setReplyingTo(c)
                    }}
                    onDelete={deleteOne}
                  />
                </div>
              )
            })}
          </div>

          <div className="border-t border-border px-4 py-4 sm:px-6 space-y-2">
            {replyingPreview ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-2">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">
                    Replying to{' '}
                    <span className="text-foreground font-medium">{replyingPreview.author}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                    {replyingPreview.text}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 ml-auto"
                  title="Cancel reply"
                  onClick={() => setReplyingTo(null)}
                  disabled={loading}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Textarea
                placeholder={canMakeComments ? 'Type an internal comment…' : 'You do not have permission to comment.'}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                className="resize-none"
                disabled={loading || !canMakeComments}
              />
              <Button
                type="button"
                variant="default"
                size="icon"
                onClick={() => void submit()}
                disabled={loading || !canMakeComments || !newComment.trim()}
                title="Send"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>

            <div className="text-xs text-muted-foreground">
              Press Enter to send & Shift+Enter for new line
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
