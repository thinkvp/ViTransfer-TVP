'use client'

import { Comment } from '@prisma/client'
import { Clock, Trash2, CornerDownRight, ChevronDown, ChevronRight, Download } from 'lucide-react'
import { timecodeToSeconds, formatTimecodeDisplay } from '@/lib/timecode'
import DOMPurify from 'dompurify'
import { CommentFileDisplay } from './FileDisplay'

let domPurifyConfigured = false

function configureDomPurify() {
  if (domPurifyConfigured) return
  domPurifyConfigured = true

  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    if (!node || node.tagName !== 'A') return

    const href = (node.getAttribute?.('href') || '').toString()
    const target = (node.getAttribute?.('target') || '').toString()

    const isInternal = href.startsWith('/') || href.startsWith('#')
    const isHttpLink = href.startsWith('http://') || href.startsWith('https://')

    // For external http(s) links, force new tab + safe rel.
    if (isHttpLink && !isInternal) {
      node.setAttribute?.('target', '_blank')
      node.setAttribute?.('rel', 'noopener noreferrer nofollow')
      return
    }

    // For any other link, only allow target=_blank if rel is safe.
    if (target === '_blank') {
      node.setAttribute?.('rel', 'noopener noreferrer nofollow')
    } else {
      node.removeAttribute?.('target')
      node.removeAttribute?.('rel')
    }
  })
}

type CommentWithReplies = Comment & {
  replies?: Comment[]
  files?: Array<{ id: string; fileName: string; fileSize: number }>
}

interface MessageBubbleProps {
  comment: CommentWithReplies
  isReply: boolean
  isStudio: boolean
  studioCompanyName: string
  clientCompanyName?: string | null
  showFrames?: boolean
  timecodeDurationSeconds?: number
  parentComment?: Comment | null
  onReply?: () => void
  onSeekToTimestamp?: (timestamp: number, videoId: string, videoVersion: number | null) => void
  onDelete?: () => void
  onScrollToComment?: (commentId: string) => void
  formatMessageTime: (date: Date) => string
  commentsDisabled: boolean
  isViewerMessage: boolean // Is this the viewer's own message?
  // Props for extended bubble with replies
  replies?: Comment[]
  repliesExpanded?: boolean
  onToggleReplies?: () => void
  onDeleteReply?: (replyId: string) => void
  canDeleteReply?: (reply: Comment) => boolean
  onDownloadCommentFile?: (commentId: string, fileId: string, fileName: string) => Promise<void>
}

/**
 * Sanitize HTML content for display
 * Defense in depth: Even though content is sanitized on backend,
 * we sanitize again on frontend for extra security
 */
function sanitizeContent(content: string): string {
  configureDomPurify()
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i, // Only allow https://, http://, mailto: URLs
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true, // Parse content as body to prevent context-breaking attacks
  })
}

export default function MessageBubble({
  comment,
  isReply,
  isStudio,
  studioCompanyName,
  clientCompanyName,
  showFrames = true,
  timecodeDurationSeconds,
  parentComment,
  onReply,
  onSeekToTimestamp,
  onDelete,
  onScrollToComment,
  formatMessageTime,
  commentsDisabled,
  isViewerMessage,
  replies,
  repliesExpanded,
  onToggleReplies,
  onDeleteReply,
  canDeleteReply,
  onDownloadCommentFile,
}: MessageBubbleProps) {
  const hasReplies = replies && replies.length > 0

  // Flat blocks (no chat bubbles).
  // Border colors match the timeline marker colors:
  // - internal/studio/admin: neutral foreground
  // - client: neutral muted-foreground

  // Get effective author name
  // For internal comments without authorName, fall back to user.name or user.email
  const effectiveAuthorName = comment.authorName ||
    (comment.isInternal && (comment as any).user ?
      ((comment as any).user.name || (comment as any).user.email) :
      null)

  const fallbackBorderColorClass = comment.isInternal ? 'border-l-foreground' : 'border-l-muted-foreground'
  const displayColor = (comment as any)?.displayColor as string | null | undefined

  const textColor = 'text-foreground'

  const handleTimestampClick = () => {
    if (comment.timecode && onSeekToTimestamp) {
      // Convert timecode to seconds for video player seeking
      // Use 24fps as default (video player will handle the actual seek)
      const seconds = timecodeToSeconds(comment.timecode, 24)
      onSeekToTimestamp(seconds, comment.videoId, comment.videoVersion)
    }
  }

  return (
    <div className="w-full" id={`comment-${comment.id}`}>
      <div className="w-full">
        <div
          data-comment-block
          className={`bg-card border border-border ${displayColor ? '' : fallbackBorderColorClass} border-l-4 rounded-lg p-3`}
          style={displayColor ? { borderLeftColor: displayColor } : undefined}
        >
          {/* Header row: name left, time right */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">
                {effectiveAuthorName || 'Anonymous'}
              </div>
            </div>
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              {formatMessageTime(comment.createdAt)}
            </div>
          </div>

          {/* Simple reply indicator */}
          {isReply && parentComment && (() => {
            const parentEffectiveName = parentComment.authorName ||
              (parentComment.isInternal && (parentComment as any).user ?
                ((parentComment as any).user.name || (parentComment as any).user.email) :
                null)

            return (
              <div
                onClick={() => onScrollToComment?.(parentComment.id)}
                className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
              >
                <CornerDownRight className="w-3 h-3" />
                <span>Reply to {parentEffectiveName || 'Anonymous'}</span>
              </div>
            )
          })()}

          {/* Timecode prefixed inline so text can use full width when wrapping */}
          <div className={`text-sm whitespace-pre-wrap break-words leading-relaxed ${textColor}`}>
            {!isReply && comment.timecode ? (
              <button
                onClick={handleTimestampClick}
                className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap mr-2 align-baseline"
                title="Seek to this timecode"
              >
                <Clock className="w-3.5 h-3.5" />
                <span className="underline decoration-dotted">
                  {formatTimecodeDisplay(comment.timecode, {
                    showFrames,
                    durationSeconds: timecodeDurationSeconds,
                  })}
                </span>
              </button>
            ) : null}

            <span
              className="whitespace-pre-wrap break-words"
              dangerouslySetInnerHTML={{ __html: sanitizeContent(comment.content) }}
            />
          </div>

          {/* Attached Files */}
          {(comment as any).files && (comment as any).files.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              {(comment as any).files.map((file: any) => (
                <CommentFileDisplay
                  key={file.id}
                  fileId={file.id}
                  fileName={file.fileName}
                  fileSize={file.fileSize}
                  commentId={comment.id}
                  onDownload={
                    onDownloadCommentFile
                      ? async (fileId) => onDownloadCommentFile(comment.id, fileId, file.fileName)
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {/* Replies Section - Extends parent bubble */}
          {hasReplies && (
            <div className="mt-3 pt-3 border-t border-border">
              {/* Collapsible Header */}
              <button
                onClick={onToggleReplies}
                className="flex items-center justify-between w-full mb-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50 hover:bg-muted/70 hover:text-foreground transition-colors"
              >
                <span>
                  {replies.length} {replies.length === 1 ? 'Reply' : 'Replies'}
                </span>
                {repliesExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>

              {/* Reply List */}
              {repliesExpanded && (
                <div className="space-y-3">
                  {replies.map((reply) => {
                    const replyEffectiveName = reply.authorName ||
                      (reply.isInternal && (reply as any).user ?
                        ((reply as any).user.name || (reply as any).user.email) :
                        null)

                    const replyDeletable = onDeleteReply && (!canDeleteReply || canDeleteReply(reply))

                    return (
                      <div key={reply.id} className="pl-3">
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <CornerDownRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs font-semibold text-foreground truncate">
                              {replyEffectiveName || 'Anonymous'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {formatMessageTime(reply.createdAt)}
                            </span>
                            {replyDeletable && (
                              <button
                                onClick={() => onDeleteReply(reply.id)}
                                className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                                title="Delete reply"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div
                          className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground"
                          dangerouslySetInnerHTML={{ __html: sanitizeContent(reply.content) }}
                        />

                        {/* Reply Attached Files */}
                        {(reply as any).files && (reply as any).files.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-border space-y-2">
                            {(reply as any).files.map((file: any) => (
                              <CommentFileDisplay
                                key={file.id}
                                fileId={file.id}
                                fileName={file.fileName}
                                fileSize={file.fileSize}
                                commentId={reply.id}
                                onDownload={
                                  onDownloadCommentFile
                                    ? async (fileId) => onDownloadCommentFile(reply.id, fileId, file.fileName)
                                    : undefined
                                }
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Actions row (inside the block) */}
          {(!isReply && (!commentsDisabled || onDelete || onReply)) && (
            <div className="mt-3 flex items-center justify-end gap-3">
              {!isReply && !commentsDisabled && onReply && (
                <button
                  onClick={onReply}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors font-medium"
                >
                  Reply
                </button>
              )}
              {onDelete && (
                <button
                  onClick={onDelete}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors font-medium flex items-center gap-1"
                  title="Delete comment"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
