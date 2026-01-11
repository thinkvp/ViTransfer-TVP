'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Trash2, Send, CornerDownRight, X } from 'lucide-react'
import { apiDelete, apiFetch, apiPost } from '@/lib/api-client'
import { cn } from '@/lib/utils'

type InternalComment = {
  id: string
  projectId: string
  userId: string | null
  parentId: string | null
  content: string
  createdAt: string | Date
  updatedAt: string | Date
  authorName: string
  displayColor: string | null
  replies: InternalComment[]
}

function formatMessageTime(dateLike: string | Date) {
  const date = typeof dateLike === 'string' ? new Date(dateLike) : dateLike
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

function stripHtmlToPlainText(html: string) {
  if (!html) return ''
  // We store sanitized HTML; for reply preview we want plain text.
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function CommentBlock({
  comment,
  currentUserId,
  canDeleteAny,
  onReply,
  onDelete,
  parentAuthorName,
}: {
  comment: InternalComment
  currentUserId: string | null
  canDeleteAny: boolean
  onReply: (comment: InternalComment) => void
  onDelete: (comment: InternalComment) => void
  parentAuthorName?: string | null
}) {
  const isMine = Boolean(currentUserId && comment.userId && comment.userId === currentUserId)
  const canDelete = canDeleteAny || isMine

  const borderStyle = comment.displayColor ? ({ borderLeftColor: comment.displayColor } as any) : undefined
  const fallbackBorderColorClass = comment.displayColor ? '' : 'border-l-foreground'

  return (
    <div className="w-full" id={`internal-comment-${comment.id}`}>
      <div
        className={cn(
          'bg-card border border-border border-l-4 rounded-lg p-3',
          fallbackBorderColorClass
        )}
        style={borderStyle}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">
              {comment.authorName || 'Unknown'}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              {formatMessageTime(comment.createdAt)}
            </div>
            {canDelete && (
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
            )}
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
          // Content is sanitized on the server (via zod contentSchema).
          dangerouslySetInnerHTML={{ __html: comment.content }}
        />

        <div className="mt-2 flex items-center gap-2">
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

        {Array.isArray(comment.replies) && comment.replies.length > 0 ? (
          <div className="mt-3 pt-3 border-t border-border space-y-3">
            {comment.replies.map((reply) => (
              <div key={reply.id} className="pl-3">
                <CommentBlock
                  comment={reply}
                  currentUserId={currentUserId}
                  canDeleteAny={canDeleteAny}
                  onReply={onReply}
                  onDelete={onDelete}
                  parentAuthorName={comment.authorName}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ProjectInternalComments({
  projectId,
  currentUserId,
  canMakeComments,
  canDeleteAll,
}: {
  projectId: string
  currentUserId: string | null
  canMakeComments: boolean
  canDeleteAll: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [comments, setComments] = useState<InternalComment[]>([])
  const [newComment, setNewComment] = useState('')

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const [replyingTo, setReplyingTo] = useState<InternalComment | null>(null)

  const fetchComments = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch(`/api/projects/${projectId}/internal-comments`)
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to load internal comments')
      }
      const data = await response.json()
      setComments(Array.isArray(data) ? data : [])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchComments()
  }, [fetchComments])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    // Defer until after DOM paints.
    setTimeout(() => {
      const el = messagesContainerRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      shouldAutoScrollRef.current = false
    }, 0)
  }, [comments])

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

    setLoading(true)
    try {
      shouldAutoScrollRef.current = true
      await apiPost(`/api/projects/${projectId}/internal-comments`, {
        content: trimmed,
        parentId: replyingTo?.id || null,
      })
      setNewComment('')
      setReplyingTo(null)
      await fetchComments()
    } catch (e: any) {
      alert(e?.message || 'Failed to post comment')
    } finally {
      setLoading(false)
    }
  }, [fetchComments, newComment, projectId, replyingTo])

  const deleteOne = useCallback(
    async (comment: InternalComment) => {
      const ok = confirm('Delete this comment?')
      if (!ok) return

      setLoading(true)
      try {
        await apiDelete(`/api/projects/${projectId}/internal-comments/${comment.id}`)
        if (replyingTo?.id === comment.id) setReplyingTo(null)
        await fetchComments()
      } catch (e: any) {
        alert(e?.message || 'Failed to delete comment')
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
    try {
      await apiDelete(`/api/projects/${projectId}/internal-comments`)
      setReplyingTo(null)
      setNewComment('')
      await fetchComments()
    } catch (e: any) {
      alert(e?.message || 'Failed to delete all comments')
    } finally {
      setLoading(false)
    }
  }, [fetchComments, projectId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
            {canDeleteAll && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void deleteAll()}
                disabled={loading}
              >
                Delete All
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div ref={messagesContainerRef} className="max-h-[50vh] overflow-auto p-4 space-y-3">
          {comments.length === 0 && !loading ? (
            <div className="text-sm text-muted-foreground">No internal comments yet.</div>
          ) : null}

          {comments.map((c) => (
            <CommentBlock
              key={c.id}
              comment={c}
              currentUserId={currentUserId}
              canDeleteAny={canDeleteAll}
              onReply={(comment) => setReplyingTo(comment)}
              onDelete={(comment) => void deleteOne(comment)}
            />
          ))}
        </div>

        <div className="border-t border-border p-4">
          {replyingPreview ? (
            <div className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-muted-foreground">Replying to <span className="text-foreground font-medium">{replyingPreview.author}</span></div>
                  <div className="mt-1 text-muted-foreground line-clamp-2">{replyingPreview.text}</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Cancel reply"
                  onClick={() => setReplyingTo(null)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
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

          <div className="mt-2 text-xs text-muted-foreground">
            Press Enter to send & Shift+Enter for new line
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
