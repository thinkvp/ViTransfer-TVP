'use client'

import { useEffect, useState } from 'react'
import { Comment } from '@prisma/client'
import { Clock, Trash2, CornerDownRight, ChevronDown, ChevronRight, Download, Check } from 'lucide-react'
import { timecodeToSeconds, formatTimecodeDisplay } from '@/lib/timecode'
import { CommentFileDisplay } from './FileDisplay'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import VoiceNotePlayer from './VoiceNotePlayer'
import { sanitizeCommentHtml } from '@/lib/sanitize-comment-html'

type CommentWithReplies = Comment & {
  replies?: Comment[]
  files?: Array<{ id: string; fileName: string; fileSize: number }>
  avatarUrl?: string | null
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
  onResolveCommentFilePlaybackUrl?: (commentId: string, fileId: string) => Promise<string | null>

  // UI options
  showAuthorAvatar?: boolean
  showColorEdge?: boolean
  avatarClassName?: string // Override avatar size/class

  // Feedback "mark done" tick — only shown on the admin share page (never client).
  // Applies per-comment (parent and each reply carry their own state).
  showResolveControl?: boolean
  onToggleResolved?: (commentId: string, currentlyResolved: boolean) => void
}

// Green circular "mark done" tick placed in the lower-left corner of a comment.
function ResolveTick({ resolved, onClick }: { resolved: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={resolved ? 'Marked done — click to reopen' : 'Mark as done'}
      className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors ${
        resolved
          ? 'border-success-solid bg-success-solid text-success-foreground'
          : 'border-muted-foreground/40 text-transparent hover:border-success-solid hover:text-success-solid/70'
      }`}
    >
      <Check className="h-2.5 w-2.5" />
    </button>
  )
}

function isVoiceNoteFile(fileName: string): boolean {
  return /^voice-note-/i.test(String(fileName || '').trim())
}

function splitCommentFilesByVoiceNote(files: Array<{ id: string; fileName: string; fileSize: number }>) {
  const voiceNoteFiles: Array<{ id: string; fileName: string; fileSize: number }> = []
  const regularFiles: Array<{ id: string; fileName: string; fileSize: number }> = []

  for (const file of files) {
    if (isVoiceNoteFile(file.fileName)) {
      voiceNoteFiles.push(file)
    } else {
      regularFiles.push(file)
    }
  }

  return { voiceNoteFiles, regularFiles }
}

function VoiceNoteAttachment({
  commentId,
  fileId,
  onResolvePlaybackUrl,
}: {
  commentId: string
  fileId: string
  onResolvePlaybackUrl?: (commentId: string, fileId: string) => Promise<string | null>
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function loadPlaybackSource() {
      if (!onResolvePlaybackUrl) {
        setError('Unable to load voice note.')
        return
      }

      try {
        const resolved = await onResolvePlaybackUrl(commentId, fileId)
        if (!mounted) return
        if (!resolved) {
          setError('Unable to load voice note.')
          return
        }
        setSrc(resolved)
      } catch {
        if (!mounted) return
        setError('Unable to load voice note.')
      }
    }

    void loadPlaybackSource()

    return () => {
      mounted = false
    }
  }, [commentId, fileId, onResolvePlaybackUrl])

  return (
    <div className="space-y-2">
      {src ? <VoiceNotePlayer src={src} /> : null}
      {!src && !error ? <p className="text-xs text-muted-foreground">Loading voice note...</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
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
  onResolveCommentFilePlaybackUrl,
  showAuthorAvatar = false,
  showColorEdge = true,
  avatarClassName,
  showResolveControl = false,
  onToggleResolved,
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

  const avatarName = effectiveAuthorName || 'Anonymous'
  const avatarEmail = (comment as any)?.authorEmail as string | null | undefined

  const textColor = 'text-foreground'
  const commentFiles = ((comment as any).files || []) as Array<{ id: string; fileName: string; fileSize: number }>
  const { voiceNoteFiles: commentVoiceNotes, regularFiles: commentRegularFiles } = splitCommentFilesByVoiceNote(commentFiles)

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
          className={
            showColorEdge
              ? `bg-card border border-border ${displayColor ? '' : fallbackBorderColorClass} border-l-4 rounded-lg p-3`
              : 'bg-card border border-border rounded-lg p-3'
          }
          style={showColorEdge && displayColor ? { borderLeftColor: displayColor } : undefined}
        >
          {/* Header row: name left, time right */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                {showAuthorAvatar ? (
                  <InitialsAvatar
                    name={avatarName}
                    email={avatarEmail}
                    displayColor={displayColor || null}
                    avatarUrl={comment.avatarUrl}
                    className={avatarClassName ?? 'h-6 w-6 text-[10px] ring-2'}
                  />
                ) : null}
                <div className="text-sm font-semibold text-foreground truncate">
                  {effectiveAuthorName || 'Anonymous'}
                </div>
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
          <div className={`text-sm whitespace-pre-wrap wrap-break-word leading-relaxed ${textColor}`}>
            {!isReply && comment.timecode ? (
              <button
                onClick={handleTimestampClick}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap mr-2 align-baseline bg-amber-500/20 text-amber-400 border border-amber-400/50 hover:bg-amber-500/25 transition-colors"
                title="Seek to this timecode"
              >
                <Clock className="w-3 h-3 shrink-0" />
                <span className="tabular-nums">
                  {formatTimecodeDisplay(comment.timecode, {
                    showFrames,
                    durationSeconds: timecodeDurationSeconds,
                  })}
                  {comment.timecodeEnd ? (
                    <> &ndash; {formatTimecodeDisplay(comment.timecodeEnd, {
                      showFrames,
                      durationSeconds: timecodeDurationSeconds,
                    })}</>
                  ) : null}
                </span>
              </button>
            ) : null}

            <span
              className="whitespace-pre-wrap wrap-break-word"
              dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(comment.content) }}
            />
          </div>

          {/* Attached Files */}
          {commentFiles.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              {commentVoiceNotes.map((file) => (
                <VoiceNoteAttachment
                  key={file.id}
                  commentId={comment.id}
                  fileId={file.id}
                  onResolvePlaybackUrl={onResolveCommentFilePlaybackUrl}
                />
              ))}

              {commentRegularFiles.map((file) => (
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

                    const replyDisplayColor = (reply as any)?.displayColor as string | null | undefined
                    const replyAvatarName = replyEffectiveName || 'Anonymous'
                    const replyAvatarEmail = (reply as any)?.authorEmail as string | null | undefined

                    const replyDeletable = onDeleteReply && (!canDeleteReply || canDeleteReply(reply))
                    const replyFiles = ((reply as any).files || []) as Array<{ id: string; fileName: string; fileSize: number }>
                    const { voiceNoteFiles: replyVoiceNotes, regularFiles: replyRegularFiles } = splitCommentFilesByVoiceNote(replyFiles)

                    return (
                      <div key={reply.id} className="pl-3">
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <CornerDownRight className="w-3 h-3 text-muted-foreground shrink-0" />
                            {showAuthorAvatar ? (
                              <InitialsAvatar
                                name={replyAvatarName}
                                email={replyAvatarEmail}
                                displayColor={replyDisplayColor || null}
                                avatarUrl={(reply as any).avatarUrl}
                                className={avatarClassName ? `${avatarClassName} text-[9px]` : 'h-5 w-5 text-[9px] ring-2'}
                              />
                            ) : null}
                            <span className="text-xs font-semibold text-foreground truncate">
                              {replyEffectiveName || 'Anonymous'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
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
                          className="text-sm whitespace-pre-wrap wrap-break-word leading-relaxed text-foreground"
                          dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(reply.content) }}
                        />

                        {/* Reply Attached Files */}
                        {replyFiles.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-border space-y-2">
                            {replyVoiceNotes.map((file) => (
                              <VoiceNoteAttachment
                                key={file.id}
                                commentId={reply.id}
                                fileId={file.id}
                                onResolvePlaybackUrl={onResolveCommentFilePlaybackUrl}
                              />
                            ))}
                            {replyRegularFiles.map((file) => (
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

                        {/* Per-reply "mark done" tick (admin share page only) */}
                        {showResolveControl && onToggleResolved && (
                          <div className="mt-2 flex items-center">
                            <ResolveTick
                              resolved={!!(reply as any).resolvedAt}
                              onClick={() => onToggleResolved(reply.id, !!(reply as any).resolvedAt)}
                            />
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
          {(!isReply && (showResolveControl || !commentsDisabled || onDelete || onReply)) && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex items-center">
                {showResolveControl && onToggleResolved && (
                  <ResolveTick
                    resolved={!!(comment as any).resolvedAt}
                    onClick={() => onToggleResolved(comment.id, !!(comment as any).resolvedAt)}
                  />
                )}
              </div>
              <div className="flex items-center gap-3">
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
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
