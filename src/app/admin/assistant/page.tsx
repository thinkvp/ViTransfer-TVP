'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import {
  Sparkles,
  Loader2,
  Paperclip,
  X,
  Info,
  Mail,
  FileText,
  Mic,
  FolderKanban,
  Receipt,
  Lightbulb,
  Check,
  Mail as MailIcon,
  Copy,
  ArrowUp,
  SquarePen,
  MessageSquareText,
} from 'lucide-react'
import type { ResolvedReplyDraft } from '@/lib/ai/proposal-schemas'
import { apiFetch, apiPost } from '@/lib/api-client'
import { cn, formatFileSize } from '@/lib/utils'
import type { AssistantResult } from '@/lib/ai/proposal-schemas'
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentKindForFileName,
} from '@/lib/ai/attachments'
import { ProjectProposalCard } from '@/components/admin/assistant/ProjectProposalCard'
import { SalesProposalCard } from '@/components/admin/assistant/SalesProposalCard'
import type { AssistantAttachment, ClientOption } from '@/components/admin/assistant/helpers'

type TurnStatus = 'running' | 'done' | 'failed'

/** Flags captured at submit time — drive the create request and any later refine of it */
interface SubmittedFlags {
  wantProject: boolean
  wantSales: boolean
  wantReply: boolean
  docType: 'QUOTE' | 'INVOICE' | 'BOTH'
}

interface Turn {
  id: number
  /** What the user typed for this turn */
  prompt: string
  /** Files attached to a create turn — kept with base64 so the project card can upload the originals */
  attachments: AssistantAttachment[]
  /** Whether this turn refined a prior result rather than creating from scratch */
  isRefine: boolean
  status: TurnStatus
  statusText?: string
  showQueuedHint?: boolean
  error?: string
  result?: AssistantResult
  provider?: string
  submitted: SubmittedFlags
}

const POLL_INTERVAL_MS = 2500
const POLL_MAX_MS = 6 * 60 * 1000 // local models can take a few minutes
const STUCK_QUEUED_HINT_MS = 30_000

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

// Web Speech API — vendor-prefixed in Chromium/Safari, absent in Firefox
type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null
}

/** Small selectable chip for the intent pills (Project / Quote / Invoice / Response) */
function Pill({
  active,
  disabled,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  icon: typeof FolderKanban
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
        disabled && 'opacity-50 pointer-events-none'
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {children}
      {active && <Check className="w-3 h-3" />}
    </button>
  )
}

/** Assemble the full copy/paste reply text: body + relevant work links + signature */
function assembleReplyText(reply: ResolvedReplyDraft): string {
  const parts = [reply.body.trim()]
  if (reply.portfolio.length > 0) {
    parts.push(['Some relevant work:', ...reply.portfolio.map((p) => `- ${p.title}: ${p.url}`)].join('\n'))
  }
  if (reply.signature) parts.push(reply.signature.trim())
  return parts.join('\n\n')
}

/** A one-line marker for a section that a later turn has re-issued below */
function SupersededChip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <MessageSquareText className="w-3.5 h-3.5 shrink-0" />
      {label} — updated below
    </div>
  )
}

function salesTypeLabel(docType: 'QUOTE' | 'INVOICE' | 'BOTH'): string {
  return docType === 'INVOICE' ? 'Invoice proposal' : docType === 'BOTH' ? 'Quote & invoice proposal' : 'Quote proposal'
}

function NoticeCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
      <div className="space-y-1 min-w-0">{children}</div>
    </div>
  )
}

function ReplyCard({ reply, onError }: { reply: ResolvedReplyDraft; onError: (msg: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Card className="border-border">
      <CardContent className="p-5 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <MailIcon className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <p className="font-medium">Suggested reply</p>
              <p className="text-xs text-muted-foreground">Copy, tweak and send from your own inbox.</p>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(assembleReplyText(reply))
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch {
                onError('Could not copy to the clipboard.')
              }
            }}
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="rounded-lg border bg-muted/20 p-4 text-sm whitespace-pre-wrap">{assembleReplyText(reply)}</div>
      </CardContent>
    </Card>
  )
}

export default function AssistantPage() {
  // Conversation transcript
  const [turns, setTurns] = useState<Turn[]>([])

  // Composer
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const [attachError, setAttachError] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  // Intent pills
  const [wantProject, setWantProject] = useState(true)
  const [wantQuote, setWantQuote] = useState(true)
  const [wantInvoice, setWantInvoice] = useState(false)
  const [wantResponse, setWantResponse] = useState(false)

  // Shared review state across turns
  const [clients, setClients] = useState<ClientOption[]>([])
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState('')

  const pollRunRef = useRef(0)
  const turnSeqRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Pin the composer to the bottom of the viewport by clamping the page to the space
  // below the admin header. Measured directly (the --admin-header-height CSS var is
  // unreliable here), so the transcript scrolls internally instead of the whole page.
  const [rootHeight, setRootHeight] = useState<string>('100dvh')
  useLayoutEffect(() => {
    const measure = () => {
      const el = rootRef.current
      if (!el) return
      // Absolute document offset of the page top (= header height); scroll-independent
      const offsetTop = el.getBoundingClientRect().top + window.scrollY
      setRootHeight(`${Math.max(320, Math.round(window.innerHeight - offsetTop))}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Voice dictation — two paths, both appending finalized speech to the prompt:
  //  - Whisper (preferred when configured in Settings): MediaRecorder captures a
  //    clip, the worker transcribes it (the web app can't reach the NAS Whisper
  //    server), and the page polls for the text. Much more accurate.
  //  - Web Speech API fallback (browser-local; Chromium/Safari only).
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [whisperDictation, setWhisperDictation] = useState(false)
  const [listening, setListening] = useState(false) // recording, either path
  const [transcribing, setTranscribing] = useState(false) // Whisper round-trip after stop
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const listeningRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordTimeoutRef = useRef<number | null>(null)
  const discardRecordingRef = useRef(false)
  const dictationRunRef = useRef(0)

  const running = turns.some((t) => t.status === 'running')
  const latestResultTurn = [...turns].reverse().find((t) => t.status === 'done' && t.result) ?? null
  const latestResultTurnId = latestResultTurn?.id ?? null
  const isRefine = latestResultTurn != null
  const canAttach = !turns.some((t) => t.status === 'done' && t.result)
  const wantSales = wantQuote || wantInvoice

  useEffect(() => {
    setVoiceSupported(getSpeechRecognitionCtor() != null)

    // Whisper dictation availability (assistant-menu-gated flag endpoint)
    const canRecord =
      typeof window !== 'undefined' &&
      'MediaRecorder' in window &&
      !!navigator.mediaDevices?.getUserMedia
    if (canRecord) {
      apiFetch('/api/admin/assistant/dictation')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.available) setWhisperDictation(true)
        })
        .catch(() => {})
    }

    // Mutable-counter ref, not a DOM node — alias it so the cleanup increments
    // the live counter (cancels any in-flight transcription poll on unmount).
    const dictationRun = dictationRunRef
    return () => {
      listeningRef.current = false
      dictationRun.current++
      recognitionRef.current?.stop()
      discardRecordingRef.current = true
      try {
        mediaRecorderRef.current?.stop()
      } catch {
        // recorder already inactive
      }
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  useEffect(() => {
    // Client list feeds the review-card selectors; degrade gracefully if this
    // user lacks the Clients menu (they can still review, just not re-pick).
    apiFetch('/api/clients?active=active')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.clients) {
          setClients(data.clients.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })))
        }
      })
      .catch(() => {})
  }, [])

  // Auto-grow the composer textarea up to a cap
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [prompt])

  // Keep the newest turn in view as the conversation grows / status changes
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  function stopListening(options?: { discard?: boolean }) {
    listeningRef.current = false
    setListening(false)
    if (recordTimeoutRef.current) {
      window.clearTimeout(recordTimeoutRef.current)
      recordTimeoutRef.current = null
    }
    if (mediaRecorderRef.current) {
      // Stopping the recorder fires onstop, which submits the clip for
      // transcription unless the caller asked to discard it.
      discardRecordingRef.current = options?.discard === true
      try {
        mediaRecorderRef.current.stop()
      } catch {
        // recorder already inactive
      }
      mediaRecorderRef.current = null
    }
    recognitionRef.current?.stop()
    recognitionRef.current = null
  }

  /** Whisper path: submit the recorded clip to the worker and poll for the text. */
  async function submitDictation(mimeType: string) {
    const runId = ++dictationRunRef.current
    const blob = new Blob(recordChunksRef.current, { type: mimeType })
    recordChunksRef.current = []
    if (blob.size === 0) return
    if (blob.size > 15 * 1024 * 1024) {
      setAttachError('Recording is too long — keep dictations under a few minutes.')
      return
    }

    setTranscribing(true)
    try {
      const base64 = await readFileAsBase64(new File([blob], 'dictation', { type: mimeType }))
      const { id } = await apiPost<{ ok: boolean; id: string }>('/api/admin/assistant/dictation', {
        audioBase64: base64,
        mimeType,
      })

      const deadline = Date.now() + 3 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        if (dictationRunRef.current !== runId) return
        const res = await apiFetch(`/api/admin/assistant/requests/${id}`)
        if (!res.ok) continue
        const { request } = await res.json()
        if (request.status === 'COMPLETED') {
          const text = String((request.resultJson as { dictation?: { text?: string } } | null)?.dictation?.text ?? '').trim()
          if (text) {
            setPrompt((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text))
          }
          return
        }
        if (request.status === 'FAILED') {
          setAttachError(request.error || 'Dictation transcription failed.')
          return
        }
      }
      setAttachError('Transcription timed out — the worker may be offline.')
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : 'Dictation failed.')
    } finally {
      if (dictationRunRef.current === runId) setTranscribing(false)
    }
  }

  async function startWhisperRecording() {
    setAttachError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setAttachError('Microphone access was denied — allow it in the browser to dictate.')
      return
    }

    // Chromium/Firefox record webm/opus; Safari records mp4 (AAC). The Whisper
    // server decodes all of these via ffmpeg.
    const preferredMime =
      typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported?.('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported?.('audio/mp4')
            ? 'audio/mp4'
            : ''
    let recorder: MediaRecorder
    try {
      recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      setAttachError('Audio recording is not supported in this browser.')
      return
    }

    const baseMime = (recorder.mimeType || preferredMime || 'audio/webm').split(';')[0] || 'audio/webm'
    recordChunksRef.current = []
    discardRecordingRef.current = false
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
      if (!discardRecordingRef.current) void submitDictation(baseMime)
    }

    mediaRecorderRef.current = recorder
    mediaStreamRef.current = stream
    listeningRef.current = true
    setListening(true)
    recorder.start()
    // Hard cap so a forgotten live mic doesn't record forever
    recordTimeoutRef.current = window.setTimeout(() => {
      if (listeningRef.current) stopListening()
    }, 5 * 60 * 1000)
  }

  function startListening() {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = navigator.language || 'en-AU'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (event) => {
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) transcript += result[0].transcript
      }
      const text = transcript.trim()
      if (text) {
        setPrompt((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text))
      }
    }
    // Browsers stop recognition after silence — restart while the mic is toggled on
    recognition.onend = () => {
      if (listeningRef.current) {
        try {
          recognition.start()
        } catch {
          stopListening()
        }
      }
    }
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopListening()
        setAttachError('Microphone access was denied — allow it in the browser to dictate.')
      }
    }
    recognitionRef.current = recognition
    listeningRef.current = true
    setListening(true)
    recognition.start()
  }

  async function addFiles(files: File[] | FileList | null) {
    if (!files || files.length === 0) return
    setAttachError('')
    const errors: string[] = []
    const next: AssistantAttachment[] = []

    for (const file of Array.from(files)) {
      const kind = attachmentKindForFileName(file.name)
      if (!kind) {
        errors.push(`${file.name}: unsupported type (use .eml, .pdf, .docx or .txt)`)
        continue
      }
      if (file.size === 0) {
        errors.push(`${file.name}: file is empty`)
        continue
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${file.name}: larger than 10 MB`)
        continue
      }
      if (attachments.some((a) => a.fileName === file.name) || next.some((a) => a.fileName === file.name)) {
        errors.push(`${file.name}: already attached`)
        continue
      }
      try {
        const base64 = await readFileAsBase64(file)
        next.push({ fileName: file.name, kind, size: file.size, base64 })
      } catch {
        errors.push(`${file.name}: could not be read`)
      }
    }

    if (attachments.length + next.length > MAX_ATTACHMENTS) {
      errors.push(`At most ${MAX_ATTACHMENTS} attachments per request`)
    } else if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next])
    }
    if (errors.length > 0) setAttachError(errors.join(' · '))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function patchTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  function newChat() {
    if (listeningRef.current) stopListening({ discard: true })
    dictationRunRef.current++ // cancel any in-flight transcription poll
    pollRunRef.current++ // cancel any in-flight poll
    setTurns([])
    setLinkedProjectId(null)
    setPrompt('')
    setAttachments([])
    setAttachError('')
    setCopyError('')
  }

  // Submit a turn (create or refine) and poll it to completion, updating the turn in place.
  async function runTurn(turnId: number, payload: Record<string, unknown>) {
    const runId = ++pollRunRef.current
    try {
      const { id } = await apiPost<{ ok: boolean; id: string }>('/api/admin/assistant/requests', payload)

      const startedAt = Date.now()
      while (Date.now() - startedAt < POLL_MAX_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        if (pollRunRef.current !== runId) return

        const res = await apiFetch(`/api/admin/assistant/requests/${id}`)
        if (!res.ok) continue
        const { request } = await res.json()

        if (request.status === 'COMPLETED') {
          patchTurn(turnId, {
            status: 'done',
            statusText: undefined,
            showQueuedHint: false,
            result: request.resultJson as AssistantResult,
            provider: request.provider ?? undefined,
          })
          return
        }
        if (request.status === 'FAILED') {
          patchTurn(turnId, { status: 'failed', statusText: undefined, showQueuedHint: false, error: request.error || 'The assistant request failed.' })
          return
        }
        patchTurn(turnId, {
          statusText:
            request.status === 'QUEUED'
              ? 'Waiting for the worker…'
              : 'Generating — this can take a minute or two on a local model…',
          showQueuedHint: request.status === 'QUEUED' && Date.now() - startedAt > STUCK_QUEUED_HINT_MS,
        })
      }
      patchTurn(turnId, { status: 'failed', statusText: undefined, error: 'Timed out waiting for a result. The worker may be overloaded or offline.' })
    } catch (e) {
      if (pollRunRef.current !== runId) return
      patchTurn(turnId, { status: 'failed', statusText: undefined, error: e instanceof Error ? e.message : 'Request failed' })
    }
  }

  async function handleSend() {
    if (running) return
    const text = prompt.trim()

    if (isRefine) {
      // Continuing the conversation → refine the most recent result
      if (!text || !latestResultTurn) return
      const submitted = latestResultTurn.submitted
      const turnId = ++turnSeqRef.current
      if (listeningRef.current) stopListening({ discard: true })
      setTurns((prev) => [
        ...prev,
        { id: turnId, prompt: text, attachments: [], isRefine: true, status: 'running', statusText: 'Submitting…', submitted },
      ])
      setPrompt('')
      await runTurn(turnId, {
        prompt: text,
        refineOf: latestResultTurn.result,
        wantProject: submitted.wantProject,
        wantSales: submitted.wantSales,
        wantReply: submitted.wantReply,
        docType: submitted.docType,
      })
      return
    }

    // First turn → create from the brief + attachments
    if (!text && attachments.length === 0) return
    if (!wantProject && !wantSales && !wantResponse) return

    const docType: SubmittedFlags['docType'] = wantQuote && wantInvoice ? 'BOTH' : wantInvoice ? 'INVOICE' : 'QUOTE'
    const submitted: SubmittedFlags = { wantProject, wantSales, wantReply: wantResponse, docType }
    const attachSnapshot = attachments
    const turnId = ++turnSeqRef.current
    if (listeningRef.current) stopListening({ discard: true })
    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        prompt: text,
        attachments: attachSnapshot,
        isRefine: false,
        status: 'running',
        statusText: 'Submitting…',
        submitted,
      },
    ])
    setPrompt('')
    setAttachments([])
    setAttachError('')
    await runTurn(turnId, {
      prompt: text,
      attachments: attachSnapshot.map((a) => ({ fileName: a.fileName, base64: a.base64 })),
      wantProject,
      wantSales,
      wantReply: wantResponse,
      docType,
    })
  }

  const sendDisabled = running || (isRefine ? !prompt.trim() : (!prompt.trim() && attachments.length === 0) || (!wantProject && !wantSales && !wantResponse))

  // Chat-append rendering: a create turn shows every section it produced; a refine turn
  // shows ONLY the section(s) it changed (so revising a quote emits just the quote below).
  // A section re-issued by a later turn is shown as a one-line "updated below" marker in the
  // earlier turn, and only the latest instance of each section stays interactive.
  const doneTurns = turns.filter((t) => t.status === 'done' && t.result)
  const shownByTurn = new Map<number, { reply: boolean; project: boolean; sales: boolean }>()
  const lastShown = { reply: -1, project: -1, sales: -1 }
  doneTurns.forEach((t, idx) => {
    const r = t.result as AssistantResult
    const prev = idx > 0 ? (doneTurns[idx - 1].result as AssistantResult) : null
    const changed = (key: 'reply' | 'project' | 'sales') =>
      JSON.stringify(prev?.[key] ?? null) !== JSON.stringify(r[key] ?? null)
    const firstOrCreate = idx === 0 || !t.isRefine
    const shown = {
      reply: !!(r.reply && (r.reply as ResolvedReplyDraft).body) && (firstOrCreate || changed('reply')),
      project: !!r.project && (firstOrCreate || changed('project')),
      sales: !!r.sales && (firstOrCreate || changed('sales')),
    }
    shownByTurn.set(t.id, shown)
    if (shown.reply) lastShown.reply = t.id
    if (shown.project) lastShown.project = t.id
    if (shown.sales) lastShown.sales = t.id
  })

  return (
    <div
      ref={rootRef}
      style={{ height: rootHeight }}
      className="flex flex-col min-h-0"
      onDragEnter={(e) => {
        e.preventDefault()
        if (!canAttach || running) return
        dragDepthRef.current++
        setIsDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setIsDragging(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        dragDepthRef.current = 0
        setIsDragging(false)
        if (canAttach && !running) void addFiles(e.dataTransfer.files)
      }}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="mx-auto max-w-3xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-base font-semibold tracking-tight">AI Assistant</h1>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={newChat}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <SquarePen className="w-4 h-4" />
              New
            </button>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16 sm:py-24">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
                <Sparkles className="w-7 h-7 text-primary" />
              </div>
              <h2 className="text-xl font-semibold tracking-tight">What are we setting up?</h2>
              <p className="mt-2 text-sm text-muted-foreground max-w-md">
                Describe a brief, paste a client email, or attach a PDF. I&apos;ll draft a project, quote, invoice or
                reply — nothing is created until you confirm.
              </p>
            </div>
          ) : (
            turns.map((turn) => (
              <div key={turn.id} className="space-y-4">
                {/* User turn */}
                {(turn.prompt || turn.attachments.length > 0) && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] space-y-2">
                      {turn.prompt && (
                        <div className="rounded-2xl rounded-br-sm bg-primary/10 border border-primary/20 px-4 py-2.5 text-sm whitespace-pre-wrap">
                          {turn.prompt}
                        </div>
                      )}
                      {turn.attachments.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-2">
                          {turn.attachments.map((a) => (
                            <div key={a.fileName} className="flex items-center gap-2 text-xs border rounded-lg px-2.5 py-1 bg-muted/30">
                              {a.kind === 'email' ? (
                                <Mail className="w-3.5 h-3.5 shrink-0 text-primary" />
                              ) : (
                                <FileText className="w-3.5 h-3.5 shrink-0 text-primary" />
                              )}
                              <span className="max-w-40 truncate">{a.fileName}</span>
                              <span className="text-muted-foreground">{formatFileSize(a.size)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Assistant turn */}
                {turn.status === 'running' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      {turn.statusText || 'Working…'}
                    </div>
                    {turn.showQueuedHint && (
                      <p className="text-xs text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
                        <Info className="w-3.5 h-3.5" />
                        Still queued — the background worker looks offline or busy. It processes AI requests on the machine
                        it runs on.
                      </p>
                    )}
                  </div>
                )}

                {turn.status === 'failed' && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{turn.error}</span>
                  </div>
                )}

                {turn.status === 'done' && turn.result && (() => {
                  const result = turn.result
                  const shown = shownByTurn.get(turn.id) ?? { reply: false, project: false, sales: false }
                  const anyShown = shown.reply || shown.project || shown.sales
                  const isLatest = turn.id === latestResultTurnId
                  return (
                    <div className="space-y-4">
                      {isLatest && turn.provider && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
                            <Sparkles className="w-3 h-3" />
                            {turn.provider}
                          </span>
                          <span>Review carefully — AI output can be wrong.</span>
                        </div>
                      )}

                      {result.assumptions.length > 0 && (
                        <NoticeCallout>
                          <p className="font-medium text-foreground/90">Assumptions &amp; notes from the model</p>
                          <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                            {result.assumptions.map((a, i) => (
                              <li key={i}>{a}</li>
                            ))}
                          </ul>
                        </NoticeCallout>
                      )}

                      {shown.reply &&
                        (lastShown.reply === turn.id ? (
                          <ReplyCard reply={result.reply as ResolvedReplyDraft} onError={setCopyError} />
                        ) : (
                          <SupersededChip label="Suggested reply" />
                        ))}

                      {shown.project &&
                        (lastShown.project === turn.id ? (
                          <ProjectProposalCard
                            proposal={result.project!}
                            clients={clients}
                            attachments={turn.attachments}
                            onClientCreated={(client) => setClients((prev) => [...prev, client])}
                            onProjectCreated={({ id }) => setLinkedProjectId(id)}
                          />
                        ) : (
                          <SupersededChip label="Project proposal" />
                        ))}

                      {shown.sales &&
                        (lastShown.sales === turn.id ? (
                          <SalesProposalCard
                            proposal={result.sales!}
                            clients={clients}
                            onClientCreated={(client) => setClients((prev) => [...prev, client])}
                            linkedProjectId={linkedProjectId}
                          />
                        ) : (
                          <SupersededChip label={salesTypeLabel(result.sales!.docType)} />
                        ))}

                      {turn.isRefine && !anyShown && result.assumptions.length === 0 && (
                        <p className="text-sm text-muted-foreground">No changes were needed.</p>
                      )}

                      {isLatest && copyError && <p className="text-sm text-destructive">{copyError}</p>}
                    </div>
                  )
                })()}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Composer — pinned to the bottom of the viewport */}
      <div className="shrink-0 border-t border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 py-3 space-y-2.5">
          {/* Intent pills (create only — a continued message refines the result above) */}
          {!isRefine && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill active={wantProject} disabled={running} onClick={() => setWantProject((v) => !v)} icon={FolderKanban}>
                Project
              </Pill>
              <Pill active={wantQuote} disabled={running} onClick={() => setWantQuote((v) => !v)} icon={Receipt}>
                Quote
              </Pill>
              <Pill active={wantInvoice} disabled={running} onClick={() => setWantInvoice((v) => !v)} icon={Receipt}>
                Invoice
              </Pill>
              <Pill active={wantResponse} disabled={running} onClick={() => setWantResponse((v) => !v)} icon={MailIcon}>
                Response
              </Pill>
            </div>
          )}

          {/* Attachment chips (create only) */}
          {canAttach && attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div key={a.fileName} className="flex items-center gap-2 text-xs border rounded-lg px-2.5 py-1 bg-muted/30">
                  {a.kind === 'email' ? (
                    <Mail className="w-3.5 h-3.5 shrink-0 text-primary" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 shrink-0 text-primary" />
                  )}
                  <span className="max-w-40 truncate">{a.fileName}</span>
                  <span className="text-muted-foreground">{formatFileSize(a.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.fileName}`}
                    disabled={running}
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.fileName !== a.fileName))}
                  >
                    <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input row */}
          <div
            className={cn(
              'flex items-end gap-1.5 rounded-2xl border bg-muted/20 px-2 py-1.5 transition-colors',
              isDragging ? 'border-primary ring-2 ring-primary/30' : 'border-border'
            )}
          >
            {canAttach && (
              <button
                type="button"
                disabled={running}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                title="Attach .eml, .pdf, .docx or .txt"
                className="shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
              >
                <Paperclip className="w-5 h-5" />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              className="hidden"
              disabled={running}
              onChange={(e) => void addFiles(e.target.files)}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              value={prompt}
              disabled={running}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={isRefine ? 'Ask for a change…' : 'Describe the brief, or paste the client’s email…'}
              className="flex-1 resize-none bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-muted-foreground max-h-[200px]"
            />

            {(whisperDictation || voiceSupported) && (
              <button
                type="button"
                disabled={running || transcribing}
                onClick={() =>
                  listening
                    ? stopListening()
                    : whisperDictation
                      ? void startWhisperRecording()
                      : startListening()
                }
                aria-label={transcribing ? 'Transcribing' : listening ? 'Stop dictating' : 'Dictate'}
                title={transcribing ? 'Transcribing…' : listening ? 'Stop dictating' : 'Dictate'}
                className={cn(
                  'shrink-0 h-9 w-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-50',
                  listening
                    ? 'bg-red-500/15 text-red-500 ring-2 ring-red-500/40 animate-pulse'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                {transcribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
              </button>
            )}

            <button
              type="button"
              onClick={handleSend}
              disabled={sendDisabled}
              aria-label="Send"
              className="shrink-0 h-9 w-9 rounded-full flex items-center justify-center bg-primary text-primary-foreground transition-opacity disabled:opacity-40 hover:opacity-90"
            >
              {running ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowUp className="w-5 h-5" />}
            </button>
          </div>

          {attachError && <p className="text-xs text-destructive">{attachError}</p>}
          {listening && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              {whisperDictation
                ? 'Recording — click the mic again to transcribe.'
                : 'Listening — speech is added as you pause.'}
            </p>
          )}
          {transcribing && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Transcribing your dictation…
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
