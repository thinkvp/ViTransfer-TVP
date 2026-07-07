/**
 * Pure cue-editing operations for the subtitle editor (panel + timeline strip).
 *
 * Client-import-safe, no React, no Node APIs — shared by the editor components
 * and the dry-run script. Works on EditorCue (a SubtitleCue with a stable
 * client-side id): the server re-sorts and re-indexes on every save, so
 * SubtitleCue.index is useless as a React key or selection handle.
 *
 * Overlap policy: operations only enforce non-overlap for the cue being
 * touched. Pre-existing overlaps (Whisper/legacy data) are left alone until
 * the user drags one of the offenders — clamp math must therefore be
 * defensive and never emit start > end even on malformed input.
 */
import type { SubtitleCue } from './subtitles'
import { MAX_CUE_TEXT_LENGTH } from './subtitles'

export interface EditorCue {
  /** Client-only identity, stable across edits (not persisted). */
  id: string
  startMs: number
  endMs: number
  text: string
}

export const MIN_CUE_DURATION_MS = 200

/** Shape of the worker-generated waveform artifact (waveform.json). */
export interface WaveformPeaks {
  version: 1
  peaksPerSecond: number
  durationMs: number
  /** Normalized 0..1, one per bucket, ceil(durationSec * peaksPerSecond) entries. */
  peaks: number[]
}

let idCounter = 0
export function newCueId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through to counter
  }
  idCounter += 1
  return `cue-${Date.now().toString(36)}-${idCounter}`
}

export function toEditorCues(cues: SubtitleCue[]): EditorCue[] {
  return cues.map((c) => ({ id: newCueId(), startMs: c.startMs, endMs: c.endMs, text: c.text }))
}

export function toApiCues(cues: EditorCue[]): Array<{ startMs: number; endMs: number; text: string }> {
  return cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }))
}

function sortByStart(cues: EditorCue[]): EditorCue[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/**
 * Split a cue at timeMs. The split point is clamped so both halves are at
 * least MIN_CUE_DURATION_MS; returns null when the cue is too short to split
 * (< 2 × MIN). Text is split at the word boundary nearest the proportional
 * position of the split point within the cue; the second half gets a new id.
 */
export function splitCueAt(cues: EditorCue[], cueId: string, timeMs: number): EditorCue[] | null {
  const idx = cues.findIndex((c) => c.id === cueId)
  if (idx === -1) return null
  const cue = cues[idx]
  const dur = cue.endMs - cue.startMs
  if (dur < MIN_CUE_DURATION_MS * 2) return null

  const splitMs = Math.round(
    Math.min(cue.endMs - MIN_CUE_DURATION_MS, Math.max(cue.startMs + MIN_CUE_DURATION_MS, timeMs))
  )

  // Split text at the word boundary nearest the proportional point
  const words = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const ratio = (splitMs - cue.startMs) / dur
  let firstText = cue.text
  let secondText = ''
  if (words.length >= 2) {
    const cut = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)))
    firstText = words.slice(0, cut).join(' ')
    secondText = words.slice(cut).join(' ')
  }

  const next = [...cues]
  next.splice(idx, 1,
    { ...cue, endMs: splitMs, text: firstText },
    { id: newCueId(), startMs: splitMs, endMs: cue.endMs, text: secondText },
  )
  return next
}

/**
 * Merge a cue with the next one: spans [cue.start, next.end], texts joined
 * with a space (newline if either is multi-line). Returns null when the cue
 * is last, or when the combined text would exceed MAX_CUE_TEXT_LENGTH.
 */
export function mergeWithNext(cues: EditorCue[], cueId: string): EditorCue[] | null {
  const idx = cues.findIndex((c) => c.id === cueId)
  if (idx === -1 || idx >= cues.length - 1) return null
  const cue = cues[idx]
  const nextCue = cues[idx + 1]

  const joiner = cue.text.includes('\n') || nextCue.text.includes('\n') ? '\n' : ' '
  const combined = [cue.text.trim(), nextCue.text.trim()].filter(Boolean).join(joiner)
  if (combined.length > MAX_CUE_TEXT_LENGTH) return null

  const next = [...cues]
  next.splice(idx, 2, {
    ...cue,
    startMs: Math.min(cue.startMs, nextCue.startMs),
    endMs: Math.max(cue.endMs, nextCue.endMs),
    text: combined,
  })
  return next
}

/**
 * Clamp a proposed retiming of one cue against its neighbours, the video
 * bounds [0, durationMs], and MIN_CUE_DURATION_MS.
 *  - 'move' preserves the proposed duration (shifts to fit)
 *  - 'resize-start' pins endMs, 'resize-end' pins startMs
 * Defensive: with overlapping neighbours the available window may be
 * degenerate — the result always satisfies start < end.
 */
export function clampCueTiming(
  cues: EditorCue[],
  cueId: string,
  proposed: { startMs: number; endMs: number },
  mode: 'move' | 'resize-start' | 'resize-end',
  durationMs: number,
): { startMs: number; endMs: number } {
  const sorted = sortByStart(cues)
  const idx = sorted.findIndex((c) => c.id === cueId)
  const cue = idx >= 0 ? sorted[idx] : null
  const prev = idx > 0 ? sorted[idx - 1] : null
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null

  const videoEnd = Math.max(MIN_CUE_DURATION_MS, Math.round(durationMs))
  // Neighbour walls; with pre-existing overlaps these may cross — fall back to
  // the video bounds so the result stays sane.
  let lowWall = prev ? Math.min(prev.endMs, videoEnd) : 0
  let highWall = next ? Math.max(next.startMs, 0) : videoEnd
  if (highWall - lowWall < MIN_CUE_DURATION_MS) {
    // Degenerate window (overlapping neighbours) — allow the cue to stay where
    // it can: relax the wall that is not adjacent to the drag direction.
    lowWall = Math.max(0, Math.min(lowWall, highWall - MIN_CUE_DURATION_MS))
    highWall = Math.min(videoEnd, Math.max(highWall, lowWall + MIN_CUE_DURATION_MS))
  }

  if (mode === 'move') {
    const dur = Math.max(MIN_CUE_DURATION_MS, Math.round(proposed.endMs - proposed.startMs))
    const maxStart = highWall - dur
    const startMs = Math.round(Math.min(Math.max(proposed.startMs, lowWall), Math.max(lowWall, maxStart)))
    return { startMs, endMs: startMs + dur }
  }

  if (mode === 'resize-start') {
    const endMs = Math.round(cue ? cue.endMs : proposed.endMs)
    const startMs = Math.round(Math.min(Math.max(proposed.startMs, lowWall), endMs - MIN_CUE_DURATION_MS))
    return { startMs: Math.max(0, startMs), endMs }
  }

  // resize-end
  const startMs = Math.round(cue ? cue.startMs : proposed.startMs)
  const endMs = Math.round(Math.max(Math.min(proposed.endMs, highWall), startMs + MIN_CUE_DURATION_MS))
  return { startMs, endMs: Math.min(Math.max(endMs, startMs + MIN_CUE_DURATION_MS), Math.max(videoEnd, startMs + MIN_CUE_DURATION_MS)) }
}

/**
 * Insert a new cue at timeMs (2s default duration, shrunk to the available
 * gap between neighbours). Returns null when the gap is under
 * MIN_CUE_DURATION_MS. Result stays sorted.
 */
export function insertCueAt(
  cues: EditorCue[],
  timeMs: number,
  durationMs: number,
): { cues: EditorCue[]; newId: string } | null {
  const sorted = sortByStart(cues)
  const t = Math.min(Math.max(0, Math.round(timeMs)), Math.max(0, Math.round(durationMs)))

  // Find the enclosing gap: the previous cue ending before/at t and the next starting after t
  let gapStart = 0
  let gapEnd = Math.round(durationMs)
  for (const c of sorted) {
    if (c.endMs <= t) gapStart = Math.max(gapStart, c.endMs)
    if (c.startMs > t) { gapEnd = Math.min(gapEnd, c.startMs); break }
    // t falls inside cue c → no gap at t; try immediately after it
    if (c.startMs <= t && t < c.endMs) gapStart = Math.max(gapStart, c.endMs)
  }
  // Recompute gapEnd against gapStart (t may have been inside a cue)
  for (const c of sorted) {
    if (c.startMs >= gapStart) { gapEnd = Math.min(gapEnd, c.startMs); break }
  }

  if (gapEnd - gapStart < MIN_CUE_DURATION_MS) return null

  const start = Math.min(Math.max(t, gapStart), gapEnd - MIN_CUE_DURATION_MS)
  const end = Math.min(start + 2000, gapEnd)
  const newCue: EditorCue = { id: newCueId(), startMs: start, endMs: end, text: 'New subtitle' }
  return { cues: sortByStart([...cues, newCue]), newId: newCue.id }
}

export function deleteCue(cues: EditorCue[], cueId: string): EditorCue[] {
  return cues.filter((c) => c.id !== cueId)
}

/**
 * Lenient timestamp parser for the panel inputs. Accepts 'ss', 'ss.mmm',
 * 'mm:ss', 'mm:ss.mmm', 'hh:mm:ss', 'hh:mm:ss.mmm' (also ',' as ms
 * separator). Returns milliseconds or null when unparseable.
 */
export function parseFlexibleTimestampMs(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  if (!s) return null
  const parts = s.split(':')
  if (parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null
    seconds = seconds * 60 + parseFloat(part)
  }
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.round(seconds * 1000)
}
