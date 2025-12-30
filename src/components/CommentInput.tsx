'use client'

// Avoid importing Prisma runtime types in client components.
type Comment = any
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Send, Paperclip, X, Clock } from 'lucide-react'
import { useState } from 'react'
import { FileUploadModal } from './FileUploadModal'
import { AttachedFileDisplay } from './FileDisplay'
import { secondsToTimecode } from '@/lib/timecode'
import { MAX_FILES_PER_COMMENT } from '@/lib/fileUpload'
import { cn, formatTimestamp } from '@/lib/utils'

interface CommentInputProps {
  newComment: string
  onCommentChange: (value: string) => void
  onSubmit: () => void
  loading: boolean
  uploadProgress?: number | null
  uploadStatusText?: string
  onFileSelect?: (files: File[]) => Promise<void>
  attachedFiles?: Array<{ name: string; size: number }>
  onRemoveFile?: (index: number) => void
  allowFileUpload?: boolean

  // Timestamp
  selectedTimestamp: number | null
  onClearTimestamp: () => void
  selectedVideoFps: number // FPS of the currently selected video

  // Display
  useFullTimecode?: boolean

  // Reply state
  replyingToComment: Comment | null
  onCancelReply: () => void

  // Author name (for clients on password-protected shares)
  showAuthorInput: boolean
  authorName: string
  onAuthorNameChange: (value: string) => void

  // Restrictions
  currentVideoRestricted: boolean
  restrictionMessage?: string
  commentsDisabled: boolean

  // Optional shortcuts UI (share pages)
  showShortcutsButton?: boolean
  onShowShortcuts?: () => void

  // Optional project upload quota (client share page)
  clientUploadQuota?: { usedBytes: number; limitMB: number } | null
  onRefreshUploadQuota?: () => Promise<void>

  // Layout/styling
  containerClassName?: string
  showTopBorder?: boolean
}

export default function CommentInput({
  newComment,
  onCommentChange,
  onSubmit,
  loading,
  uploadProgress = null,
  uploadStatusText = '',
  onFileSelect,
  attachedFiles = [],
  onRemoveFile,
  allowFileUpload = false,
  selectedTimestamp,
  onClearTimestamp,
  selectedVideoFps,
  useFullTimecode = false,
  replyingToComment,
  onCancelReply,
  showAuthorInput,
  authorName,
  onAuthorNameChange,
  currentVideoRestricted,
  restrictionMessage,
  commentsDisabled,
  showShortcutsButton = false,
  onShowShortcuts,
  clientUploadQuota = null,
  onRefreshUploadQuota,
  containerClassName,
  showTopBorder = true,
}: CommentInputProps) {
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploading, setUploading] = useState(false)

  if (commentsDisabled) return null

  const hasRequiredName = !showAuthorInput || Boolean(authorName.trim())
  const canSubmit = !loading && newComment.trim() && hasRequiredName

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Allow Ctrl+Space and other Ctrl shortcuts to pass through to VideoPlayer
    if (e.ctrlKey) {
      // Don't handle Ctrl shortcuts here - let them bubble to VideoPlayer
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Prevent multiple submissions while loading
      if (canSubmit) {
        onSubmit()
      }
    }
  }

  return (
    <div
      className={cn(
        'p-4 bg-card flex-shrink-0',
        showTopBorder ? 'border-t border-border' : null,
        containerClassName
      )}
    >
      {/* Restriction Warning */}
      {currentVideoRestricted && restrictionMessage && (
        <div className="mb-3 p-3 bg-warning-visible border-2 border-warning-visible rounded-lg">
          <p className="text-sm text-warning font-medium flex items-center gap-2">
            <span className="font-semibold">Comments Restricted</span>
          </p>
          <p className="text-xs text-warning font-medium mt-1">
            {restrictionMessage}
          </p>
        </div>
      )}

      {/* Replying To Indicator */}
      {replyingToComment && (
        <div className="mb-3 p-3 bg-gray-100 dark:bg-gray-800 border-l-2 border-blue-400 rounded-lg flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-700 dark:text-gray-300 font-semibold mb-1">
              Replying to {replyingToComment.authorName || 'Anonymous'}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-2 leading-snug">
              {replyingToComment.content}
            </p>
          </div>
          <button
            onClick={onCancelReply}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-medium flex-shrink-0 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Time + Name row */}
      {!currentVideoRestricted && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 bg-warning-visible text-warning border-2 border-warning-visible flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span className="tabular-nums">
              {useFullTimecode
                ? secondsToTimecode(selectedTimestamp ?? 0, selectedVideoFps || 24)
                : formatTimestamp(selectedTimestamp ?? 0)}
            </span>
          </span>

          {showAuthorInput ? (
            <div className="flex items-center gap-2 flex-1 min-w-[220px]">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Name:</span>
              <Input
                placeholder="Enter your name"
                value={authorName}
                onChange={(e) => onAuthorNameChange(e.target.value)}
                className="text-sm"
                aria-label="Your name"
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Message Input */}
      {!currentVideoRestricted && (
        <>
          <div className="flex gap-2">
            <Textarea
              id="feedback-input"
              placeholder="Type your message..."
              value={newComment}
              onChange={(e) => onCommentChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="resize-none"
              rows={2}
              disabled={loading}
            />
            <div className="flex flex-col gap-2 self-end">
              {allowFileUpload && (
                <Button
                  onClick={async () => {
                    try {
                      await onRefreshUploadQuota?.()
                    } finally {
                      setUploadModalOpen(true)
                    }
                  }}
                  variant="outline"
                  size="icon"
                  className="bg-orange-600 text-white border-orange-600 hover:bg-orange-600 hover:text-white hover:border-orange-600 shadow-elevation hover:shadow-elevation-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-elevation"
                  title="Attach file"
                  disabled={loading || uploading || attachedFiles.length >= MAX_FILES_PER_COMMENT}
                >
                  <Paperclip className="w-4 h-4" />
                </Button>
              )}
              <Button
                onClick={onSubmit}
                variant="default"
                disabled={!canSubmit || uploading || loading}
                size="icon"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Attached File Display */}
          {attachedFiles.length > 0 && onRemoveFile && (
            <div className="mt-2">
              <div className="space-y-2">
                {attachedFiles.map((file, index) => (
                  <AttachedFileDisplay
                    key={`${file.name}-${index}`}
                    fileName={file.name}
                    fileSize={file.size}
                    onRemove={loading ? undefined : () => onRemoveFile(index)}
                    isLoading={uploading || loading}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Upload progress */}
          {loading && uploadProgress !== null && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{uploadStatusText || 'Uploading...'}</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              {showAuthorInput && !authorName.trim() ? (
                <p className="text-xs text-warning">Enter your name to send</p>
              ) : (
                <p className="text-xs text-muted-foreground">Press Enter to send & Shift+Enter for new line</p>
              )}
            </div>
            {showShortcutsButton && onShowShortcuts && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onShowShortcuts}
                className="hidden self-start sm:inline-flex sm:self-auto"
              >
                Shortcuts
              </Button>
            )}
          </div>

          {/* File Upload Modal */}
          {allowFileUpload && (
            <FileUploadModal
              open={uploadModalOpen}
              onOpenChange={setUploadModalOpen}
              quota={clientUploadQuota}
              onFileSelect={async (files) => {
                // Keep modal contract simple: add selected files to the pending list
                setUploadError('')
                setUploading(true)
                try {
                  if (clientUploadQuota && clientUploadQuota.limitMB > 0) {
                    const limitBytes = clientUploadQuota.limitMB * 1024 * 1024
                    const alreadySelectedBytes = attachedFiles.reduce((sum, f) => sum + (f.size || 0), 0)
                    const newlySelectedBytes = files.reduce((sum, f) => sum + (f.size || 0), 0)
                    if (clientUploadQuota.usedBytes + alreadySelectedBytes + newlySelectedBytes > limitBytes) {
                      const remainingBytes = Math.max(0, limitBytes - clientUploadQuota.usedBytes)
                      const remainingMB = Math.floor(remainingBytes / (1024 * 1024))
                      throw new Error(`Upload limit exceeded. Remaining allowance: ${remainingMB}MB.`)
                    }
                  }

                  if (onFileSelect) {
                    await onFileSelect(files)
                  }
                  setUploadModalOpen(false)
                } catch (err) {
                  setUploadError((err as Error).message)
                  throw err
                } finally {
                  setUploading(false)
                }
              }}
              isLoading={uploading}
              error={uploadError}
            />
          )}
        </>
      )}
    </div>
  )
}