'use client'

// Avoid importing Prisma runtime types in client components.
type Comment = any
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Send, Paperclip, Clock, ChevronDown, Check, Trash2, Keyboard, Mic, Square } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FileUploadModal } from './FileUploadModal'
import { AttachedFileDisplay } from './FileDisplay'
import VoiceNotePlayer from './VoiceNotePlayer'
import { secondsToTimecode, timecodeToSeconds } from '@/lib/timecode'
import { useTimeDisplayMode, type TimeDisplayMode } from '@/hooks/useTimeDisplayMode'
import { MAX_FILES_PER_COMMENT } from '@/lib/fileUpload'
import { cn, formatTimestamp } from '@/lib/utils'

type VoiceNoteDraft = {
  file: File
  durationSeconds: number
}

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
  voiceNoteDraft?: VoiceNoteDraft | null
  onVoiceNoteSelect?: (file: File, durationSeconds: number) => void
  onVoiceNoteClear?: () => void

  // Timestamp
  selectedTimestamp: number | null
  selectedEndTimestamp?: number | null
  onClearTimestamp: () => void
  onClearRange?: () => void
  onSetTimes?: (startSeconds: number, endSeconds: number | null) => void
  videoDurationSeconds?: number
  showTimestampReset?: boolean
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
  voiceNoteDraft = null,
  onVoiceNoteSelect,
  onVoiceNoteClear,
  selectedTimestamp,
  selectedEndTimestamp = null,
  onClearTimestamp,
  onClearRange,
  onSetTimes,
  videoDurationSeconds,
  showTimestampReset = false,
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
  const [voiceNoteError, setVoiceNoteError] = useState('')
  const [isRecordingVoiceNote, setIsRecordingVoiceNote] = useState(false)
  const [voiceNoteElapsedSeconds, setVoiceNoteElapsedSeconds] = useState(0)
  const [voiceNotePreviewUrl, setVoiceNotePreviewUrl] = useState<string | null>(null)
  const voiceNoteElapsedRef = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<BlobPart[]>([])
  const recorderIntervalRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const hasSavedRecordingRef = useRef(false)
  const customNameInputRef = useRef<HTMLInputElement>(null)

  // ── Comment in/out time editor ───────────────────────────────────────────
  // Shared display-mode hook: the Time/Timecode toggle here syncs with the
  // player and the comment list across the whole share page.
  const { timeDisplayMode, setTimeDisplayMode } = useTimeDisplayMode(useFullTimecode)
  const fps = selectedVideoFps > 0 ? selectedVideoFps : 24
  const canUseTimecode = selectedVideoFps > 0
  const isTimecodeMode = timeDisplayMode === 'timecode' && canUseTimecode

  const [timePopoverOpen, setTimePopoverOpen] = useState(false)
  const timePopoverRef = useRef<HTMLDivElement>(null)
  const [inSegs, setInSegs] = useState<string[]>([])
  const [outSegs, setOutSegs] = useState<string[]>([])
  const [outActive, setOutActive] = useState(false)
  const [timeError, setTimeError] = useState('')
  // Authoritative duration pulled from the player on open (the prop may be
  // missing in some contexts); used to validate against the real video length.
  const [playerDuration, setPlayerDuration] = useState<number | null>(null)
  // Per-segment <input> refs so a filled segment can auto-advance to the next.
  const segRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const effectiveDuration =
    playerDuration !== null
      ? playerDuration
      : typeof videoDurationSeconds === 'number' && videoDurationSeconds > 0
        ? videoDurationSeconds
        : null

  const showHours =
    (effectiveDuration ?? 0) >= 3600 ||
    (selectedTimestamp ?? 0) >= 3600 ||
    (selectedEndTimestamp ?? 0) >= 3600

  const pad2 = (n: number) => String(n).padStart(2, '0')

  // The ordered segment boxes shown in the editor for the active mode.
  const segDefs = useMemo<Array<{ key: string; max: number; label: string }>>(() => {
    if (isTimecodeMode) {
      return [
        { key: 'h', max: 99, label: 'hours' },
        { key: 'm', max: 59, label: 'minutes' },
        { key: 's', max: 59, label: 'seconds' },
        { key: 'f', max: Math.max(1, Math.round(fps)) - 1, label: 'frames' },
      ]
    }
    if (showHours) {
      return [
        { key: 'h', max: 99, label: 'hours' },
        { key: 'm', max: 59, label: 'minutes' },
        { key: 's', max: 59, label: 'seconds' },
      ]
    }
    return [
      { key: 'm', max: 59, label: 'minutes' },
      { key: 's', max: 59, label: 'seconds' },
    ]
  }, [isTimecodeMode, showHours, fps])

  // Helper text shows only the shape that applies to this video.
  const formatHelper = isTimecodeMode ? 'HH:MM:SS:FF' : showHours ? 'HH:MM:SS' : 'MM:SS'

  // Format seconds for the active display mode (badge above the box).
  const formatForMode = (totalSeconds: number) => {
    const s = Math.max(0, totalSeconds)
    if (isTimecodeMode) return secondsToTimecode(s, fps)
    const whole = Math.floor(s)
    const h = Math.floor(whole / 3600)
    const m = Math.floor((whole % 3600) / 60)
    const sec = whole % 60
    if (showHours) return `${h}:${pad2(m)}:${pad2(sec)}`
    return `${m}:${pad2(sec)}`
  }

  // Split seconds into the per-segment 2-digit strings for the active mode.
  const secondsToSegs = (totalSeconds: number): string[] => {
    const s = Math.max(0, totalSeconds)
    if (isTimecodeMode) {
      return secondsToTimecode(s, fps).replace(';', ':').split(':')
    }
    const whole = Math.floor(s)
    const sec = whole % 60
    if (showHours) {
      const h = Math.floor(whole / 3600)
      const m = Math.floor((whole % 3600) / 60)
      return [pad2(h), pad2(m), pad2(sec)]
    }
    return [pad2(Math.floor(whole / 60)), pad2(sec)]
  }

  // Join the per-segment strings back into seconds (empty = 0). Returns null if
  // a segment is out of range for its unit (e.g. 75 seconds, or frame ≥ fps).
  const segsToSeconds = (segs: string[]): number | null => {
    const nums = segDefs.map((_, i) => {
      const raw = (segs[i] ?? '').trim()
      if (raw === '') return 0
      if (!/^\d+$/.test(raw)) return NaN
      return parseInt(raw, 10)
    })
    if (nums.some((n) => Number.isNaN(n))) return null
    if (segDefs.some((d, i) => nums[i] > d.max)) return null
    if (isTimecodeMode) {
      const [h, m, s, f] = nums
      return timecodeToSeconds(`${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`, fps)
    }
    if (showHours) {
      const [h, m, s] = nums
      return h * 3600 + m * 60 + s
    }
    const [m, s] = nums
    return m * 60 + s
  }

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

  const clearRecorderTimer = () => {
    if (recorderIntervalRef.current != null) {
      window.clearInterval(recorderIntervalRef.current)
      recorderIntervalRef.current = null
    }
  }

  const stopMediaStream = () => {
    if (!streamRef.current) return
    for (const track of streamRef.current.getTracks()) {
      track.stop()
    }
    streamRef.current = null
  }

  const stopVoiceNoteRecording = (saveRecording: boolean) => {
    const recorder = recorderRef.current
    if (!recorder) return

    hasSavedRecordingRef.current = saveRecording
    if (recorder.state === 'recording') {
      recorder.stop()
    }
  }

  const startVoiceNoteRecording = async () => {
    if (isRecordingVoiceNote) return
    setVoiceNoteError('')

    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      setVoiceNoteError('Voice note recording is not supported in this browser.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)

      streamRef.current = stream
      recorderRef.current = recorder
      recorderChunksRef.current = []
      hasSavedRecordingRef.current = false
      setVoiceNoteElapsedSeconds(0)
      voiceNoteElapsedRef.current = 0
      setIsRecordingVoiceNote(true)

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recorderChunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        setVoiceNoteError('Recording failed. Please try again.')
      }

      recorder.onstop = () => {
        clearRecorderTimer()
        setIsRecordingVoiceNote(false)

        const chunks = recorderChunksRef.current
        recorderChunksRef.current = []
        stopMediaStream()
        recorderRef.current = null

        if (!hasSavedRecordingRef.current || chunks.length === 0) {
          return
        }

        const mimeType = recorder.mimeType || 'audio/webm'
        const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm'
        const durationSeconds = Math.max(1, voiceNoteElapsedRef.current)
        const fileName = `voice-note-${Date.now()}-${durationSeconds}s.${extension}`
        const blob = new Blob(chunks, { type: mimeType })
        const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() })
        onVoiceNoteSelect?.(file, durationSeconds)
      }

      recorder.start(250)
      recorderIntervalRef.current = window.setInterval(() => {
        setVoiceNoteElapsedSeconds((prev) => {
          const next = prev + 1
          voiceNoteElapsedRef.current = next
          if (next >= 120) {
            stopVoiceNoteRecording(true)
            return 120
          }
          return next
        })
      }, 1000)
    } catch (error) {
      const errName = (error as DOMException | undefined)?.name || ''
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setVoiceNoteError('Microphone permission was denied. Please allow microphone access in your browser.')
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        setVoiceNoteError('No microphone was found on this device.')
      } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
        setVoiceNoteError('Microphone is already in use by another application.')
      } else if (errName === 'SecurityError') {
        setVoiceNoteError('Microphone access is blocked by browser security settings for this site.')
      } else {
        setVoiceNoteError('Unable to start microphone recording. Please check browser permissions and try again.')
      }
      setIsRecordingVoiceNote(false)
      clearRecorderTimer()
      stopMediaStream()
      recorderRef.current = null
    }
  }

  useEffect(() => {
    if (!voiceNoteDraft?.file) {
      setVoiceNotePreviewUrl(null)
      return
    }

    const objectUrl = URL.createObjectURL(voiceNoteDraft.file)
    setVoiceNotePreviewUrl(objectUrl)

    return () => {
      URL.revokeObjectURL(objectUrl)
    }
  }, [voiceNoteDraft])

  useEffect(() => {
    return () => {
      clearRecorderTimer()
      stopMediaStream()
      recorderRef.current = null
    }
  }, [])

  // Seed the popover inputs from the current selection each time it opens, and
  // pull the authoritative duration/fps from the player.
  useEffect(() => {
    if (!timePopoverOpen) return
    const inSec = Math.max(0, selectedTimestamp ?? 0)
    const hasOut = selectedEndTimestamp !== null
    setInSegs(secondsToSegs(inSec))
    setOutActive(hasOut)
    setOutSegs(secondsToSegs(hasOut ? (selectedEndTimestamp as number) : inSec))
    setTimeError('')
    window.dispatchEvent(
      new CustomEvent('getCommentTimeContext', {
        detail: {
          callback: (ctx: { duration?: number } | undefined) => {
            if (ctx && typeof ctx.duration === 'number' && ctx.duration > 0) {
              setPlayerDuration(ctx.duration)
            }
          },
        },
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timePopoverOpen])

  // The comment-time pill is hidden while replying, so close the popover too.
  useEffect(() => {
    if (replyingToComment) setTimePopoverOpen(false)
  }, [replyingToComment])

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!timePopoverOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (timePopoverRef.current && !timePopoverRef.current.contains(e.target as Node)) {
        setTimePopoverOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTimePopoverOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [timePopoverOpen])

  // Re-derive the segment boxes when the display mode is toggled while open
  // (the number of segments changes between Time and Timecode).
  useEffect(() => {
    if (!timePopoverOpen) return
    const inSec = Math.max(0, selectedTimestamp ?? 0)
    const hasOut = selectedEndTimestamp !== null
    setInSegs(secondsToSegs(inSec))
    setOutSegs(secondsToSegs(hasOut ? (selectedEndTimestamp as number) : inSec))
    setTimeError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeDisplayMode])

  const exceedsDuration = (seconds: number) =>
    effectiveDuration !== null && seconds > effectiveDuration + 0.5

  const focusSeg = (field: 'in' | 'out', index: number) => {
    const el = segRefs.current[`${field}-${index}`]
    if (el) {
      el.focus()
      el.select()
    }
  }

  // Apply a field's segments to the timeline live, with validation.
  const applySegs = (field: 'in' | 'out', inSegsNow: string[], outSegsNow: string[]) => {
    if (field === 'in') {
      const total = segsToSeconds(inSegsNow)
      if (total === null) return
      if (exceedsDuration(total)) {
        setTimeError('Past the end of the video.')
        return
      }
      if (!outActive) {
        // No OUT set yet: mirror IN → OUT and drop a single point marker.
        setOutSegs(secondsToSegs(total))
        setTimeError('')
        onSetTimes?.(total, null)
        return
      }
      const outSec = segsToSeconds(outSegsNow)
      if (outSec !== null && total > outSec + 0.001) {
        setTimeError('In can’t be after out.')
        return
      }
      setTimeError('')
      onSetTimes?.(total, outSec)
      return
    }

    const total = segsToSeconds(outSegsNow)
    if (total === null) return
    if (exceedsDuration(total)) {
      setTimeError('Past the end of the video.')
      return
    }
    const inSec = segsToSeconds(inSegsNow) ?? Math.max(0, selectedTimestamp ?? 0)
    if (total + 0.001 < inSec) {
      setTimeError('Out can’t be before in.')
      return
    }
    setTimeError('')
    onSetTimes?.(inSec, total)
  }

  const handleSegChange = (field: 'in' | 'out', index: number, rawValue: string) => {
    const def = segDefs[index]
    let digits = rawValue.replace(/\D/g, '').slice(0, 2)
    if (digits !== '' && parseInt(digits, 10) > def.max) digits = String(def.max)

    const base = field === 'in' ? inSegs : outSegs
    const next = segDefs.map((_, i) => (i === index ? digits : base[i] ?? ''))

    if (field === 'in') {
      setInSegs(next)
      applySegs('in', next, outSegs)
    } else {
      setOutActive(true)
      setOutSegs(next)
      applySegs('out', inSegs, next)
    }

    // Auto-advance once this segment can't take another digit.
    const full =
      digits.length === 2 || (digits.length === 1 && parseInt(digits, 10) * 10 > def.max)
    if (full && index < segDefs.length - 1) {
      focusSeg(field, index + 1)
    }
  }

  // On blur, pad to two digits (or revert to the applied selection if invalid).
  const handleSegBlur = (field: 'in' | 'out', e: React.FocusEvent<HTMLInputElement>) => {
    // Skip while moving between segments of the same field — that avoids
    // clobbering a just-typed digit during auto-advance (state hasn't flushed yet).
    const related = e.relatedTarget as HTMLElement | null
    if (related && segDefs.some((_, i) => segRefs.current[`${field}-${i}`] === related)) return
    if (field === 'out' && !outActive) return
    const segs = field === 'in' ? inSegs : outSegs
    const setSegs = field === 'in' ? setInSegs : setOutSegs
    const total = segsToSeconds(segs)
    if (total === null) {
      const fallback =
        field === 'in'
          ? Math.max(0, selectedTimestamp ?? 0)
          : selectedEndTimestamp !== null
            ? (selectedEndTimestamp as number)
            : Math.max(0, selectedTimestamp ?? 0)
      setSegs(secondsToSegs(fallback))
      return
    }
    const clamped = effectiveDuration !== null ? Math.min(total, effectiveDuration) : total
    setSegs(secondsToSegs(clamped))
  }

  const handleToggleMode = (mode: TimeDisplayMode) => {
    if (mode === 'timecode' && !canUseTimecode) return
    setTimeDisplayMode(mode)
  }

  if (commentsDisabled) return null

  const hasRequiredName = !showAuthorInput || Boolean(authorName.trim())
  const canSubmit = !loading && (Boolean(newComment.trim()) || Boolean(voiceNoteDraft)) && hasRequiredName

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

  const displayedStartTimestamp = selectedTimestamp ?? 0
  const displayedEndTimestamp = selectedEndTimestamp
  const displayTime = formatForMode(displayedStartTimestamp)
  const displayRangeTime = displayedEndTimestamp !== null
    ? `${displayTime} - ${formatForMode(displayedEndTimestamp)}`
    : displayTime

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
        <div className="mb-3 p-3 bg-gray-800 border-l-2 border-primary rounded-lg flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-300 font-semibold mb-1">
              Replying to {replyingToComment.authorName || 'Anonymous'}
            </p>
            <p className="text-xs text-gray-400 line-clamp-2 leading-snug">
              {replyingToComment.content}
            </p>
          </div>
          <button
            onClick={onCancelReply}
            className="text-xs text-gray-500 hover:text-gray-300 font-medium flex-shrink-0 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Name row */}
      {!currentVideoRestricted && (
        <div className="mb-3 flex items-center gap-3 min-w-0">
          {showAuthorInput ? (
            <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Name:</span>
              <Dialog open={namePickerOpen} onOpenChange={setNamePickerOpen}>
                <button
                  type="button"
                  onClick={() => setNamePickerOpen(true)}
                  className={cn(
                    'h-9 w-full flex-1 rounded-md border bg-background px-3 py-2 text-sm ring-offset-background',
                    'flex items-center justify-between gap-2',
                    'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    authorName.trim() ? 'border-input' : 'border-destructive ring-1 ring-destructive bg-destructive/10'
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

            </div>
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
            <DialogContent portalContainer={dialogPortalContainer} className="max-w-[95vw] sm:max-w-md">
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

          <div>
            {/* Replies thread under a parent comment and carry no timeline position,
                so the comment-time pill doesn't apply while replying — hide it. */}
            {!currentVideoRestricted && !replyingToComment && (
              <div className="w-full rounded-t-lg border border-input border-b-0 bg-muted/35 px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs">
                <div className="relative min-w-0" ref={timePopoverRef}>
                  <button
                    type="button"
                    onClick={() => setTimePopoverOpen((o) => !o)}
                    className="min-w-0 inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-amber-300 font-medium tabular-nums hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                    title="Edit comment in/out time"
                    aria-label="Edit comment in and out time"
                    aria-haspopup="dialog"
                    aria-expanded={timePopoverOpen}
                  >
                    <Clock className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{displayRangeTime}</span>
                  </button>

                  {timePopoverOpen && (
                    <div
                      role="dialog"
                      aria-label="Comment time"
                      className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-elevation-lg"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-foreground">Comment time</span>
                        <div className="inline-flex flex-shrink-0 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
                          <button
                            type="button"
                            onClick={() => handleToggleMode('duration')}
                            className={cn(
                              'rounded px-2.5 py-1 transition-colors',
                              timeDisplayMode === 'duration'
                                ? 'bg-background text-foreground font-medium shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            Time
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleMode('timecode')}
                            disabled={!canUseTimecode}
                            title={!canUseTimecode ? 'Timecode requires FPS metadata on this video' : undefined}
                            className={cn(
                              'rounded px-2.5 py-1 transition-colors',
                              timeDisplayMode === 'timecode' && canUseTimecode
                                ? 'bg-background text-foreground font-medium shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                              !canUseTimecode && 'opacity-40 cursor-not-allowed hover:text-muted-foreground'
                            )}
                          >
                            TC
                          </button>
                        </div>
                      </div>

                      <div className={cn('flex gap-3', isTimecodeMode ? 'flex-col' : 'flex-row')}>
                        <div className="flex-1 space-y-1">
                          <span className="text-xs font-medium text-foreground">Comment in</span>
                          <div className="flex items-center gap-0.5">
                            {segDefs.map((def, i) => (
                              <Fragment key={`in-${def.key}`}>
                                {i > 0 && (
                                  <span className="text-muted-foreground" aria-hidden>
                                    :
                                  </span>
                                )}
                                <input
                                  ref={(el) => {
                                    segRefs.current[`in-${i}`] = el
                                  }}
                                  inputMode="numeric"
                                  autoComplete="off"
                                  aria-label={`Comment in ${def.label}`}
                                  value={inSegs[i] ?? ''}
                                  placeholder="00"
                                  onChange={(e) => handleSegChange('in', i, e.target.value)}
                                  onFocus={(e) => e.currentTarget.select()}
                                  onBlur={(e) => handleSegBlur('in', e)}
                                  className="h-9 w-8 rounded-md border border-input bg-background text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                                />
                              </Fragment>
                            ))}
                          </div>
                          <p className="text-[11px] text-muted-foreground tabular-nums">{formatHelper}</p>
                        </div>
                        <div className="flex-1 space-y-1">
                          <span className="text-xs font-medium text-foreground">Comment out</span>
                          <div className="flex items-center gap-0.5">
                            {segDefs.map((def, i) => (
                              <Fragment key={`out-${def.key}`}>
                                {i > 0 && (
                                  <span
                                    className={cn(!outActive ? 'text-muted-foreground/60' : 'text-muted-foreground')}
                                    aria-hidden
                                  >
                                    :
                                  </span>
                                )}
                                <input
                                  ref={(el) => {
                                    segRefs.current[`out-${i}`] = el
                                  }}
                                  inputMode="numeric"
                                  autoComplete="off"
                                  aria-label={`Comment out ${def.label}`}
                                  value={outSegs[i] ?? ''}
                                  placeholder="00"
                                  onChange={(e) => handleSegChange('out', i, e.target.value)}
                                  onFocus={(e) => e.currentTarget.select()}
                                  onBlur={(e) => handleSegBlur('out', e)}
                                  className={cn(
                                    'h-9 w-8 rounded-md border border-input bg-background text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                    !outActive && 'text-muted-foreground'
                                  )}
                                />
                              </Fragment>
                            ))}
                          </div>
                          <p className="text-[11px] text-muted-foreground tabular-nums">{formatHelper}</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 text-xs leading-tight text-destructive">
                          {timeError}
                        </p>
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          className="flex-shrink-0"
                          onClick={() => setTimePopoverOpen(false)}
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  {showTimestampReset && (
                    <button
                      type="button"
                      onClick={onClearTimestamp}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                      title="Reset to original timestamp"
                    >
                      Reset
                    </button>
                  )}

                  {selectedEndTimestamp !== null && (
                  <button
                    type="button"
                    onClick={() => onClearRange?.()}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    title="Reset out time"
                    aria-label="Reset out time"
                  >
                    Reset
                  </button>
                  )}
                </div>
              </div>
            )}

            <Textarea
              id="feedback-input"
              placeholder="Type your message..."
              value={newComment}
              onChange={(e) => onCommentChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                // A reply has no timeline position — don't spawn a comment-range marker.
                if (replyingToComment) return
                window.dispatchEvent(new CustomEvent('activateCommentRange'))
              }}
              className={cn(
                'resize-none',
                !currentVideoRestricted && !replyingToComment && 'rounded-t-none border-t-0'
              )}
              rows={2}
              disabled={loading}
            />

            <div className="mt-2 flex items-center gap-2">
              <div className="min-w-0 flex-1 text-xs leading-tight">
                {showAuthorInput && !authorName.trim() ? (
                  <p className="text-warning">Enter your name to send</p>
                ) : (
                  <p className="hidden text-muted-foreground sm:block">
                    <span className="block">Enter to send</span>
                    <span className="block">Shift+Enter for new line</span>
                  </p>
                )}
              </div>

              {showShortcutsButton && onShowShortcuts && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onShowShortcuts}
                  aria-label="Keyboard shortcuts"
                  title="Keyboard shortcuts"
                >
                  <Keyboard className="h-4 w-4" />
                </Button>
              )}

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
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shadow-elevation hover:shadow-elevation-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-elevation"
                  title="Attach file"
                  aria-label="Attach file"
                  disabled={loading || uploading || attachedFiles.length >= MAX_FILES_PER_COMMENT}
                >
                  <Paperclip className="w-4 h-4" />
                </Button>
              )}

              <Button
                type="button"
                variant={isRecordingVoiceNote ? 'destructive' : 'outline'}
                size="icon"
                onClick={() => {
                  if (isRecordingVoiceNote) {
                    stopVoiceNoteRecording(true)
                    return
                  }
                  void startVoiceNoteRecording()
                }}
                title={isRecordingVoiceNote ? 'Stop recording' : 'Record voice note'}
                aria-label={isRecordingVoiceNote ? 'Stop recording' : 'Record voice note'}
                disabled={loading || uploading}
              >
                {isRecordingVoiceNote ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>

              <Button
                onClick={onSubmit}
                variant="default"
                disabled={!canSubmit || uploading || loading}
                size="icon"
                aria-label="Send comment"
                title="Send comment"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>

            {isRecordingVoiceNote ? (
              <div className="mt-2 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs text-foreground">
                Recording voice note: {formatTimestamp(Math.min(voiceNoteElapsedSeconds, 120))} / 2:00
              </div>
            ) : null}

            {voiceNoteError ? (
              <div className="mt-2 text-xs text-destructive">{voiceNoteError}</div>
            ) : null}

            {voiceNoteDraft && voiceNotePreviewUrl ? (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Voice note preview ({formatTimestamp(voiceNoteDraft.durationSeconds)})
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      onVoiceNoteClear?.()
                      setVoiceNoteError('')
                    }}
                    disabled={loading || uploading}
                  >
                    Remove
                  </Button>
                </div>
                <VoiceNotePlayer src={voiceNotePreviewUrl} />
              </div>
            ) : null}
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