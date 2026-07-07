'use client'

/**
 * Subtitle editor state — one instance per feedback grid; the edit panel and
 * the timeline strip both consume the same returned object, so selection,
 * cues, dirty state and the playhead are shared by construction.
 *
 * Player sync stays on the existing window event channels: 'videoTimeUpdated'
 * in (250ms cadence), 'seekToTime' out, 'subtitlesUpdated' out after save
 * (VideoPlayer bumps its <track> cache-bust), 'videoChanged' as a backstop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAccessToken } from '@/lib/token-store'
import { serializeSrt, serializeVtt, cuesToTranscriptTxt, type SubtitleCue } from '@/lib/subtitles'
import {
  toEditorCues,
  toApiCues,
  splitCueAt,
  mergeWithNext,
  clampCueTiming,
  insertCueAt,
  deleteCue,
  type EditorCue,
  type WaveformPeaks,
} from '@/lib/subtitle-edit'

const UNDO_LIMIT = 50

export interface UseSubtitleEditorArgs {
  videoId: string | null
  videoName: string
  versionLabel: string
  videoDurationSec: number
  shareToken: string | null
  isAdmin: boolean
  /** Edit mode on/off — the hook only loads/holds state while active. */
  active: boolean
  hasWaveform: boolean
  /** Page-supplied content-token minting (share fetchVideoToken / admin getAdminVideoToken). */
  fetchContentToken: (videoId: string, quality: string) => Promise<string | null>
  onExit: () => void
}

export interface SubtitleEditorApi {
  cues: EditorCue[]
  loading: boolean
  saving: boolean
  error: string | null
  notice: string | null
  dirty: boolean
  selectedCueId: string | null
  activeCueId: string | null
  currentTimeMs: number
  durationMs: number
  peaks: WaveformPeaks | null
  isAdmin: boolean
  videoName: string
  versionLabel: string
  canSave: boolean
  selectCue: (id: string | null, opts?: { seek?: boolean }) => void
  updateCueText: (id: string, text: string) => void
  /** Snapshot for undo at the START of a text-edit session (textarea focus). */
  beginTextEdit: () => void
  retimeCue: (id: string, proposed: { startMs: number; endMs: number }, mode: 'move' | 'resize-start' | 'resize-end') => void
  clampPreview: (id: string, proposed: { startMs: number; endMs: number }, mode: 'move' | 'resize-start' | 'resize-end') => { startMs: number; endMs: number }
  splitAt: (id: string, timeMs?: number) => void
  mergeNext: (id: string) => void
  remove: (id: string) => void
  insertAtPlayhead: () => void
  undo: () => void
  canUndo: boolean
  save: () => Promise<boolean>
  discard: () => void
  confirmAndExit: () => void
  /** For video-switch interception: true = OK to proceed (not dirty, or user confirmed). */
  guard: () => boolean
  seekTo: (timeMs: number) => void
  exportSrt: () => void
  exportTranscript: () => void
  regenerate: () => Promise<void>
}

function buildAuthHeaders(shareToken: string | null, isAdmin: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = shareToken || (isAdmin ? getAccessToken() : null)
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function downloadBlob(content: string, mimeType: string, fileName: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function useSubtitleEditor(args: UseSubtitleEditorArgs): SubtitleEditorApi {
  const {
    videoId, videoName, versionLabel, videoDurationSec,
    shareToken, isAdmin, active, hasWaveform, fetchContentToken, onExit,
  } = args

  const [cues, setCues] = useState<EditorCue[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null)
  const [undoStack, setUndoStack] = useState<EditorCue[][]>([])

  const loadRunRef = useRef(0)
  const loadedVideoIdRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const cuesRef = useRef<EditorCue[]>([])
  const currentTimeMsRef = useRef(0)
  const peaksCacheRef = useRef<Map<string, WaveformPeaks | null>>(new Map())
  // Latest-value mirrors for event handlers / imperative callers (refs must
  // not be written during render under react-hooks 7's refs rule)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  useEffect(() => {
    cuesRef.current = cues
  }, [cues])

  const durationMs = Math.max(0, Math.round(videoDurationSec * 1000))

  // -------------------------------------------------------------------------
  // Load cues when edit mode activates or the video changes
  // -------------------------------------------------------------------------
  const loadCues = useCallback(async (forVideoId: string) => {
    const runId = ++loadRunRef.current
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/videos/${forVideoId}/subtitles`, {
        headers: buildAuthHeaders(shareToken, isAdmin),
        cache: 'no-store',
      })
      if (loadRunRef.current !== runId) return
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || 'Failed to load subtitles')
      }
      const data = await response.json()
      const serverCues: SubtitleCue[] = Array.isArray(data.cues) ? data.cues : []
      setCues(toEditorCues(serverCues))
      setDirty(false)
      setUndoStack([])
      setSelectedCueId(null)
      loadedVideoIdRef.current = forVideoId
    } catch (e) {
      if (loadRunRef.current !== runId) return
      setError(e instanceof Error ? e.message : 'Failed to load subtitles')
      setCues([])
      loadedVideoIdRef.current = null
    } finally {
      if (loadRunRef.current === runId) setLoading(false)
    }
  }, [shareToken, isAdmin])

  useEffect(() => {
    if (active && videoId) void loadCues(videoId)
  }, [active, videoId, loadCues])

  // -------------------------------------------------------------------------
  // Waveform peaks (lazy, cached per video)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!active || !videoId) { setPeaks(null); return }
    if (!hasWaveform) { setPeaks(null); return }
    const cached = peaksCacheRef.current.get(videoId)
    if (cached !== undefined) { setPeaks(cached); return }

    let cancelled = false
    ;(async () => {
      try {
        const token = await fetchContentToken(videoId, 'waveform-peaks')
        if (!token) throw new Error('no token')
        const res = await fetch(`/api/content/${token}`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const json = (await res.json()) as WaveformPeaks
        if (json?.version !== 1 || !Array.isArray(json.peaks)) throw new Error('bad shape')
        peaksCacheRef.current.set(videoId, json)
        if (!cancelled) setPeaks(json)
      } catch {
        peaksCacheRef.current.set(videoId, null)
        if (!cancelled) setPeaks(null)
      }
    })()
    return () => { cancelled = true }
  }, [active, videoId, hasWaveform, fetchContentToken])

  // -------------------------------------------------------------------------
  // Playhead from the player + video-change backstop
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!active) return
    const onTime = (e: Event) => {
      const detail = (e as CustomEvent).detail as { time?: number; videoId?: string } | undefined
      if (!detail || detail.videoId !== videoId) return
      const ms = Math.round((detail.time ?? 0) * 1000)
      currentTimeMsRef.current = ms
      setCurrentTimeMs(ms)
    }
    const onVideoChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { videoId?: string } | undefined
      // Backstop: a switch slipped past the guards while dirty — drop edits
      // and reload for the new video (save() would refuse anyway).
      if (detail?.videoId && detail.videoId !== loadedVideoIdRef.current && dirtyRef.current) {
        console.warn('[subtitle-editor] video changed with unsaved edits — discarding')
        setDirty(false)
      }
    }
    window.addEventListener('videoTimeUpdated', onTime as EventListener)
    window.addEventListener('videoChanged', onVideoChanged as EventListener)
    return () => {
      window.removeEventListener('videoTimeUpdated', onTime as EventListener)
      window.removeEventListener('videoChanged', onVideoChanged as EventListener)
    }
  }, [active, videoId])

  // -------------------------------------------------------------------------
  // Derived: active cue (sorted array — cache last hit for the common case)
  // -------------------------------------------------------------------------
  const activeCueId = useMemo(() => {
    for (const c of cues) {
      if (c.startMs <= currentTimeMs && currentTimeMs < c.endMs) return c.id
    }
    return null
  }, [cues, currentTimeMs])

  // -------------------------------------------------------------------------
  // Mutations (each pushes one undo entry)
  // -------------------------------------------------------------------------
  const pushUndo = useCallback((snapshot: EditorCue[]) => {
    setUndoStack((prev) => {
      const next = [...prev, snapshot]
      return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next
    })
  }, [])

  const applyChange = useCallback((mutate: (prev: EditorCue[]) => EditorCue[] | null, failNotice?: string) => {
    setError(null)
    setNotice(null)
    const prev = cuesRef.current
    const next = mutate(prev)
    if (next === null) {
      if (failNotice) setNotice(failNotice)
      return
    }
    pushUndo(prev)
    setCues(next)
    setDirty(true)
  }, [pushUndo])

  const seekTo = useCallback((timeMs: number) => {
    if (!videoId) return
    window.dispatchEvent(new CustomEvent('seekToTime', {
      detail: { timestamp: timeMs / 1000, videoId, videoVersion: null },
    }))
  }, [videoId])

  const selectCue = useCallback((id: string | null, opts?: { seek?: boolean }) => {
    setSelectedCueId(id)
    if (id && opts?.seek) {
      const cue = cuesRef.current.find((c) => c.id === id)
      if (cue) seekTo(cue.startMs)
    }
  }, [seekTo])

  const textEditSnapshotRef = useRef<EditorCue[] | null>(null)
  const beginTextEdit = useCallback(() => {
    textEditSnapshotRef.current = cuesRef.current
  }, [])

  const updateCueText = useCallback((id: string, text: string) => {
    // One undo entry per edit session (snapshot taken on focus)
    if (textEditSnapshotRef.current) {
      pushUndo(textEditSnapshotRef.current)
      textEditSnapshotRef.current = null
    }
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)))
    setDirty(true)
  }, [pushUndo])

  const clampPreview = useCallback((id: string, proposed: { startMs: number; endMs: number }, mode: 'move' | 'resize-start' | 'resize-end') => {
    return clampCueTiming(cuesRef.current, id, proposed, mode, durationMs)
  }, [durationMs])

  const retimeCue = useCallback((id: string, proposed: { startMs: number; endMs: number }, mode: 'move' | 'resize-start' | 'resize-end') => {
    applyChange((prev) => {
      const clamped = clampCueTiming(prev, id, proposed, mode, durationMs)
      const next = prev.map((c) => (c.id === id ? { ...c, ...clamped } : c))
      next.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
      return next
    })
  }, [applyChange, durationMs])

  const splitAt = useCallback((id: string, timeMs?: number) => {
    const cue = cuesRef.current.find((c) => c.id === id)
    if (!cue) return
    const playhead = currentTimeMsRef.current
    const t = timeMs ?? (cue.startMs < playhead && playhead < cue.endMs
      ? playhead
      : Math.round((cue.startMs + cue.endMs) / 2))
    applyChange((prev) => splitCueAt(prev, id, t), 'Cue is too short to split.')
  }, [applyChange])

  const mergeNext = useCallback((id: string) => {
    applyChange((prev) => mergeWithNext(prev, id), 'Cannot merge — combined text would be too long (or this is the last cue).')
  }, [applyChange])

  const remove = useCallback((id: string) => {
    applyChange((prev) => deleteCue(prev, id))
    setSelectedCueId((sel) => (sel === id ? null : sel))
  }, [applyChange])

  const insertAtPlayhead = useCallback(() => {
    let insertedId: string | null = null
    applyChange((prev) => {
      const result = insertCueAt(prev, currentTimeMsRef.current, durationMs)
      if (!result) return null
      insertedId = result.newId
      return result.cues
    }, 'No room for a new cue at the playhead.')
    if (insertedId) setSelectedCueId(insertedId)
  }, [applyChange, durationMs])

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev
      const snapshot = prev[prev.length - 1]
      setCues(snapshot)
      setDirty(true)
      return prev.slice(0, -1)
    })
  }, [])

  // -------------------------------------------------------------------------
  // Save / discard / exit
  // -------------------------------------------------------------------------
  const canSave = cues.filter((c) => c.text.trim() !== '').length > 0

  const save = useCallback(async (): Promise<boolean> => {
    if (!videoId) return false
    if (loadedVideoIdRef.current !== videoId) {
      setError('Video changed since subtitles were loaded — reload before saving.')
      return false
    }
    const payload = toApiCues(cuesRef.current).filter((c) => c.text.trim() !== '')
    if (payload.length === 0) {
      setError('Subtitles must contain at least one cue — deleting all cues is not supported.')
      return false
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/videos/${videoId}/subtitles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(shareToken, isAdmin) },
        body: JSON.stringify({ cues: payload }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || 'Failed to save subtitles')
      }
      // Re-GET so the UI matches server normalization (trim/sort/re-index)
      await loadCues(videoId)
      setNotice('Subtitles saved.')
      window.dispatchEvent(new CustomEvent('subtitlesUpdated', { detail: { videoId } }))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save subtitles')
      return false
    } finally {
      setSaving(false)
    }
  }, [videoId, shareToken, isAdmin, loadCues])

  const discard = useCallback(() => {
    if (!videoId) return
    if (dirtyRef.current && !window.confirm('Discard all unsaved subtitle changes?')) return
    void loadCues(videoId)
  }, [videoId, loadCues])

  const guard = useCallback((): boolean => {
    if (!dirtyRef.current) return true
    return window.confirm('You have unsaved subtitle changes. Discard them?')
  }, [])

  const confirmAndExit = useCallback(() => {
    if (!guard()) return
    setDirty(false)
    onExit()
  }, [guard, onExit])

  // Live preview: push the current cues as serialized VTT *text* to the player so
  // edits appear on the video immediately (no Save needed). Debounced. The player
  // populates a single caption track's cues from this text — we deliberately do NOT
  // hand it a blob URL, because swapping the <track> src left stale TextTracks/cues
  // behind and stacked two captions at once.
  const toSubtitleCuesForPreview = useMemo(
    () => (list: EditorCue[]): SubtitleCue[] => list.map((c, i) => ({ index: i + 1, startMs: c.startMs, endMs: c.endMs, text: c.text })),
    [],
  )
  useEffect(() => {
    if (!active || !videoId) return
    const id = videoId
    const handle = window.setTimeout(() => {
      let vtt: string | null = null
      try {
        vtt = serializeVtt(toSubtitleCuesForPreview(cuesRef.current.filter((c) => c.text.trim() !== '')))
      } catch {
        vtt = null
      }
      window.dispatchEvent(new CustomEvent('subtitlePreview', { detail: { videoId: id, vtt } }))
    }, 250)
    return () => window.clearTimeout(handle)
  }, [active, videoId, cues, toSubtitleCuesForPreview])

  // Clear the live preview whenever edit mode ends (or the video changes).
  useEffect(() => {
    if (active) return
    window.dispatchEvent(new CustomEvent('subtitlePreview', { detail: { videoId, vtt: null } }))
  }, [active, videoId])

  // Warn on tab close / reload with unsaved edits
  useEffect(() => {
    if (!active || !dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active, dirty])

  // -------------------------------------------------------------------------
  // Exports + regenerate (ported from the modal)
  // -------------------------------------------------------------------------
  const exportBaseName = useMemo(() => {
    const base = `${videoName}_${versionLabel}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
    return base || 'subtitles'
  }, [videoName, versionLabel])

  const toSubtitleCues = useCallback((): SubtitleCue[] =>
    cuesRef.current.map((c, i) => ({ index: i + 1, startMs: c.startMs, endMs: c.endMs, text: c.text })), [])

  const exportSrt = useCallback(() => {
    downloadBlob(serializeSrt(toSubtitleCues()), 'application/x-subrip;charset=utf-8', `${exportBaseName}_captions.srt`)
  }, [exportBaseName, toSubtitleCues])

  const exportTranscript = useCallback(() => {
    downloadBlob(cuesToTranscriptTxt(toSubtitleCues()), 'text/plain;charset=utf-8', `${exportBaseName}_transcript.txt`)
  }, [exportBaseName, toSubtitleCues])

  const regenerate = useCallback(async () => {
    if (!videoId) return
    if (!window.confirm('Regenerate subtitles from the audio? This overwrites all edits (saved and unsaved).')) return
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/videos/${videoId}/subtitles/regenerate`, {
        method: 'POST',
        headers: buildAuthHeaders(shareToken, isAdmin),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || 'Failed to queue transcription')
      }
      setDirty(false)
      peaksCacheRef.current.delete(videoId)
      setNotice('Transcription queued — new subtitles will replace these when the worker finishes.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to queue transcription')
    }
  }, [videoId, shareToken, isAdmin])

  return {
    cues, loading, saving, error, notice, dirty,
    selectedCueId, activeCueId, currentTimeMs, durationMs, peaks,
    isAdmin, videoName, versionLabel, canSave,
    selectCue, updateCueText, beginTextEdit, retimeCue, clampPreview,
    splitAt, mergeNext, remove, insertAtPlayhead,
    undo, canUndo: undoStack.length > 0,
    save, discard, confirmAndExit, guard, seekTo,
    exportSrt, exportTranscript, regenerate,
  }
}
