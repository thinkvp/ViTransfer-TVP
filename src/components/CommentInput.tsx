'use client'

// Avoid importing Prisma runtime types in client components.
type Comment = any
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Send, Paperclip, X, Clock, ChevronDown, Check, ArrowLeft, ArrowRight, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
  recipientId?: string | null
  onRecipientIdChange?: (value: string | null) => void
  onRecipientSelect?: (name: string, recipientId: string | null) => void
  recipients?: Array<{ id?: string; name?: string | null; email?: string | null }>

  // Optional share auth context (share pages)
  shareSlug?: string
  shareToken?: string | null

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
  containerStyle?: CSSProperties
  showTopBorder?: boolean

  // Optional: move the comment input between columns (share pages, desktop only)
  moveColumnDirection?: 'left' | 'right'
  onMoveColumn?: () => void

  // Optional: portal dialogs into a specific container (needed for element fullscreen)
  dialogPortalContainer?: HTMLElement | null

  // Fullscreen overlay mode (used to adjust behaviors like file uploads)
  isInFullscreenMode?: boolean
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
  recipientId = null,
  onRecipientIdChange,
  onRecipientSelect,
  recipients = [],
  shareSlug,
  shareToken,
  currentVideoRestricted,
  restrictionMessage,
  commentsDisabled,
  showShortcutsButton = false,
  onShowShortcuts,
  clientUploadQuota = null,
  onRefreshUploadQuota,
  containerClassName,
  containerStyle,
  showTopBorder = true,
  moveColumnDirection = 'right',
  onMoveColumn,
  dialogPortalContainer = null,
  isInFullscreenMode = false,
}: CommentInputProps) {
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [fullscreenUploadNotSupportedOpen, setFullscreenUploadNotSupportedOpen] = useState(false)
  const [namePickerOpen, setNamePickerOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customNameError, setCustomNameError] = useState('')
  const [addingCustomName, setAddingCustomName] = useState(false)
  const [deletingCustomRecipientIds, setDeletingCustomRecipientIds] = useState<Set<string>>(
    () => new Set()
  )
  const [customRecipients, setCustomRecipients] = useState<
    Array<{ id: string; name: string; createdAtMs: number }>
  >([])
  const [deleteTick, setDeleteTick] = useState(0)
  const customNameInputRef = useRef<HTMLInputElement>(null)

  const baseRecipientOptions = useMemo(() => {
    const unique: Array<{ id?: string; name: string }> = []
    const seen = new Set<string>()

    for (const recipient of recipients) {
      const trimmed = (recipient?.name || '').trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push({ id: recipient?.id, name: trimmed })
    }

    return unique
  }, [recipients])

  const recipientOptions = useMemo(() => {
    const customIdSet = new Set(customRecipients.map((r) => r.id))
    const seenName = new Set<string>()
    const result: Array<{ id?: string; name: string; isCustom: boolean }> = []

    const push = (opt: { id?: string; name: string; isCustom: boolean }) => {
      const trimmed = opt.name.trim()
      if (!trimmed) return
      const key = trimmed.toLowerCase()
      if (seenName.has(key)) return
      seenName.add(key)
      result.push({ ...opt, name: trimmed })
    }

    // Base recipients first, excluding any custom IDs so custom entries always render at the bottom.
    for (const opt of baseRecipientOptions) {
      if (opt.id && customIdSet.has(opt.id)) continue
      push({ ...opt, isCustom: false })
    }

    // Custom entries last
    for (const custom of customRecipients) {
      push({ id: custom.id, name: custom.name, isCustom: true })
    }

    return result
  }, [baseRecipientOptions, customRecipients])

  // Keep recipientId in sync if authorName changes externally.
  // (Example: restoring from storage, or user typing a custom name.)
  useEffect(() => {
    if (!authorName.trim()) return
    // If the selected name matches a known option with an id, prefer that id.
    const match = recipientOptions.find((o) => o.name === authorName.trim() && o.id)
    if (match?.id) {
      if (recipientId === match.id) return
      if (onRecipientSelect) {
        onRecipientSelect(match.name, match.id)
      } else {
        onRecipientIdChange?.(match.id)
      }
    }
  }, [authorName, onRecipientIdChange, onRecipientSelect, recipientId, recipientOptions])

  useEffect(() => {
    if (!namePickerOpen) return

    const trimmedAuthor = authorName.trim()
    const isRecipientName =
      Boolean(trimmedAuthor) && recipientOptions.some((o) => o.name === trimmedAuthor)

    // If they previously entered a custom name, keep it editable.
    // If they selected a recipient name, start with an empty custom name.
    setCustomName(isRecipientName ? '' : trimmedAuthor)
    setCustomNameError('')

    // Focus the custom name input on open (handy if there are no recipients, or they want a custom entry).
    setTimeout(() => {
      customNameInputRef.current?.focus()
      customNameInputRef.current?.select()
    }, 0)
  }, [namePickerOpen, authorName, recipientOptions])

  useEffect(() => {
    if (!namePickerOpen) return
    const hasDeletable = customRecipients.some((r) => Date.now() - r.createdAtMs < 60 * 1000)
    if (!hasDeletable) return

    const id = setInterval(() => setDeleteTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [namePickerOpen, customRecipients])

  const addCustomNameAsRecipient = async () => {
    const trimmed = customName.trim()
    if (!trimmed) return

    // Prevent duplicates by name (case-insensitive). This mirrors server-side enforcement.
    const normalized = trimmed.toLowerCase()
    const alreadyExists = recipientOptions.some((o) => o.name.trim().toLowerCase() === normalized)
    if (alreadyExists) {
      setCustomNameError('That name is already in the list. Please select it instead.')
      return
    }

    // If this CommentInput instance isn't on a share page with auth, fall back to the old behavior.
    if (!shareSlug || !shareToken) {
      onAuthorNameChange(trimmed)
      setNamePickerOpen(false)
      return
    }

    setAddingCustomName(true)
    setCustomNameError('')
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(shareSlug)}/recipients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shareToken}`,
        },
        body: JSON.stringify({ name: trimmed }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setCustomNameError(String(data?.error || 'Failed to add custom name'))
        return
      }

      const id = String(data?.recipient?.id || '')
      const name = String(data?.recipient?.name || trimmed).trim()
      const createdAtMs = data?.recipient?.createdAt
        ? new Date(String(data.recipient.createdAt)).getTime()
        : Date.now()

      if (!id || !name) {
        setCustomNameError('Failed to add custom name')
        return
      }

      setCustomRecipients((prev) => {
        if (prev.some((r) => r.id === id)) return prev
        return [...prev, { id, name, createdAtMs }]
      })

      window.dispatchEvent(
        new CustomEvent('shareRecipientsChanged', {
          detail: { action: 'add', recipient: { id, name } },
        })
      )

      setCustomName('')
      setCustomNameError('')
    } catch {
      setCustomNameError('Failed to add custom name')
    } finally {
      setAddingCustomName(false)
    }
  }

  const deleteCustomRecipient = async (recipientId: string) => {
    if (!shareSlug || !shareToken) return

    const deletedName = customRecipients.find((r) => r.id === recipientId)?.name

    setDeletingCustomRecipientIds((prev) => {
      const next = new Set(prev)
      next.add(recipientId)
      return next
    })

    try {
      const response = await fetch(`/api/share/${encodeURIComponent(shareSlug)}/recipients`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shareToken}`,
        },
        body: JSON.stringify({ recipientId }),
      })

      if (!response.ok) {
        return
      }

      setCustomRecipients((prev) => prev.filter((r) => r.id !== recipientId))

      window.dispatchEvent(
        new CustomEvent('shareRecipientsChanged', {
          detail: { action: 'delete', recipientId },
        })
      )

      // If they had selected this name, clear it so they can choose again.
      if (deletedName && authorName.trim() === deletedName.trim()) {
        onAuthorNameChange('')
      }
    } finally {
      setDeletingCustomRecipientIds((prev) => {
        const next = new Set(prev)
        next.delete(recipientId)
        return next
      })
    }
  }

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
      style={containerStyle}
      className={cn(
        'p-4 bg-card flex-shrink-0 min-w-0',
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
        <div className="mb-3 p-3 bg-gray-100 dark:bg-gray-800 border-l-2 border-primary rounded-lg flex items-start justify-between gap-3">
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
        <div className="mb-3 flex items-center gap-3 min-w-0">
          <span className="px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 bg-warning-visible text-warning border-2 border-warning-visible flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span className="tabular-nums">
              {useFullTimecode
                ? secondsToTimecode(selectedTimestamp ?? 0, selectedVideoFps || 24)
                : formatTimestamp(selectedTimestamp ?? 0)}
            </span>
          </span>

          {showAuthorInput ? (
            <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Name:</span>
              <Dialog open={namePickerOpen} onOpenChange={setNamePickerOpen}>
                <button
                  type="button"
                  onClick={() => setNamePickerOpen(true)}
                  className={cn(
                    'h-9 w-full flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
                    'flex items-center justify-between gap-2',
                    'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                  )}
                  aria-label="Your name"
                >
                  <span
                    className={cn(
                      'truncate whitespace-nowrap min-w-0',
                      authorName.trim() ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {authorName.trim() ? authorName.trim() : 'Select your name'}
                  </span>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </button>
                <DialogContent
                  portalContainer={dialogPortalContainer}
                  className="bg-card border-border text-card-foreground max-w-[95vw] sm:max-w-md"
                >
                  <DialogHeader>
                    <DialogTitle>Choose your name</DialogTitle>
                    <DialogDescription>
                      Pick an existing recipient name, or enter a custom name.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    {recipientOptions.length > 0 ? (
                      <div className="space-y-2">
                        {recipientOptions.map((opt) => {
                          const name = opt.name
                          const isSelected = authorName.trim() === name
                          const customMeta = opt.id
                            ? customRecipients.find((r) => r.id === opt.id)
                            : null
                          const canDelete = Boolean(
                            opt.isCustom &&
                              opt.id &&
                              customMeta &&
                              Date.now() - customMeta.createdAtMs < 60 * 1000
                          )
                          // Force a re-render while the 60s window is active
                          void deleteTick
                          return (
                            <Button
                              key={opt.id ? `${opt.id}:${name}` : name}
                              type="button"
                              variant="outline"
                              className="w-full justify-between"
                              onClick={() => {
                                const pickedId = opt.id ? String(opt.id) : null
                                if (onRecipientSelect) {
                                  onRecipientSelect(name, pickedId)
                                } else {
                                  onAuthorNameChange(name)
                                  onRecipientIdChange?.(pickedId)
                                }
                                setNamePickerOpen(false)
                              }}
                            >
                              <span className="truncate">{name}</span>
                              <span className="flex items-center gap-2">
                                {canDelete && opt.id ? (
                                  <button
                                    type="button"
                                    className="inline-flex items-center justify-center rounded-sm text-destructive hover:text-destructive/90"
                                    aria-label={`Delete ${name}`}
                                    disabled={deletingCustomRecipientIds.has(opt.id)}
                                    onClick={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      deleteCustomRecipient(opt.id!)
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                ) : null}
                                {isSelected ? <Check className="h-4 w-4 flex-shrink-0" /> : null}
                              </span>
                            </Button>
                          )
                        })}
                      </div>
                    ) : null}

                    <div className="border-t border-border pt-4">
                      <div className="text-sm font-medium text-foreground">Enter a custom name</div>
                      <div className="mt-2 flex flex-col gap-2">
                        <Input
                          ref={customNameInputRef}
                          placeholder="Enter a custom name"
                          value={customName}
                          maxLength={30}
                          onChange={(e) => setCustomName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addCustomNameAsRecipient()
                            }
                          }}
                          className="text-sm"
                        />
                        <Button
                          type="button"
                          variant="default"
                          disabled={!customName.trim() || addingCustomName}
                          onClick={addCustomNameAsRecipient}
                        >
                          Add a custom name
                        </Button>
                        {customNameError ? (
                          <div className="text-xs text-destructive">{customNameError}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {onMoveColumn ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="hidden lg:inline-flex h-9 w-9 flex-shrink-0"
                  onClick={onMoveColumn}
                  aria-label={
                    moveColumnDirection === 'right'
                      ? 'Move comment box to right column'
                      : 'Move comment box to left column'
                  }
                  title={
                    moveColumnDirection === 'right'
                      ? 'Move comment box to right column'
                      : 'Move comment box to left column'
                  }
                >
                  {moveColumnDirection === 'right' ? (
                    <ArrowRight className="h-4 w-4" />
                  ) : (
                    <ArrowLeft className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}

          {!showAuthorInput && onMoveColumn ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="ml-auto hidden lg:inline-flex h-9 w-9 flex-shrink-0"
              onClick={onMoveColumn}
              aria-label={
                moveColumnDirection === 'right'
                  ? 'Move comment box to right column'
                  : 'Move comment box to left column'
              }
              title={
                moveColumnDirection === 'right'
                  ? 'Move comment box to right column'
                  : 'Move comment box to left column'
              }
            >
              {moveColumnDirection === 'right' ? (
                <ArrowRight className="h-4 w-4" />
              ) : (
                <ArrowLeft className="h-4 w-4" />
              )}
            </Button>
          ) : null}
        </div>
      )}

      {/* Message Input */}
      {!currentVideoRestricted && (
        <>
          <Dialog
            open={fullscreenUploadNotSupportedOpen}
            onOpenChange={setFullscreenUploadNotSupportedOpen}
          >
            <DialogContent portalContainer={dialogPortalContainer} className="bg-background dark:bg-card border-border text-foreground dark:text-card-foreground max-w-[95vw] sm:max-w-md">
              <DialogHeader>
                <DialogTitle>File uploads are not supported in fullscreen mode</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Exit fullscreen to attach files.
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFullscreenUploadNotSupportedOpen(false)
                    window.dispatchEvent(new CustomEvent('requestExitVideoFullscreen'))
                  }}
                >
                  Exit Fullscreen
                </Button>

                <Button
                  type="button"
                  variant="default"
                  onClick={() => setFullscreenUploadNotSupportedOpen(false)}
                >
                  Okay
                </Button>
              </div>
            </DialogContent>
          </Dialog>

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
                    if (isInFullscreenMode) {
                      setFullscreenUploadNotSupportedOpen(true)
                      return
                    }
                    try {
                      await onRefreshUploadQuota?.()
                    } finally {
                      setUploadModalOpen(true)
                    }
                  }}
                  variant="outline"
                  size="icon"
                  className="shadow-elevation hover:shadow-elevation-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-elevation"
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
              <p
                className={`text-xs ${
                  showAuthorInput && !authorName.trim()
                    ? 'text-warning'
                    : 'text-muted-foreground invisible sm:visible'
                }`}
              >
                {showAuthorInput && !authorName.trim()
                  ? 'Enter your name to send'
                  : 'Press Enter to send & Shift+Enter for new line'}
              </p>
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
              portalContainer={dialogPortalContainer}
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