/**
 * SRT/WebVTT subtitle parsing + serialization.
 *
 * Pure, dependency-free, client-import-safe (no Node APIs): shared by the
 * worker (Whisper SRT → VTT derivative), the cue edit API routes, the
 * subtitle editor (client-side .srt/.txt exports), and the dry-run script.
 *
 * The SRT file stored as the video's "subtitles" VideoAsset is the source of
 * truth; every write re-serializes BOTH the SRT and the playback VTT from the
 * same cue array so they can never drift.
 */

export interface SubtitleCue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export const MAX_CUES = 20000
export const MAX_CUE_TEXT_LENGTH = 1000

// 00:01:23,450 (SRT) or 00:01:23.450 (VTT); hours may be 1-2+ digits
const TIMESTAMP_RE = /^(\d{1,4}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})$/

function parseTimestampMs(raw: string): number | null {
  const m = TIMESTAMP_RE.exec(raw.trim())
  if (!m) return null
  const [, h, min, s, ms] = m
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(min, 10) * 60_000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms.padEnd(3, '0'), 10)
  )
}

function formatTimestamp(totalMs: number, msSeparator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(totalMs))
  const h = Math.floor(clamped / 3_600_000)
  const min = Math.floor((clamped % 3_600_000) / 60_000)
  const s = Math.floor((clamped % 60_000) / 1000)
  const ms = clamped % 1000
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(h, 2)}:${pad(min, 2)}:${pad(s, 2)}${msSeparator}${pad(ms, 3)}`
}

/** Human-readable cue timestamp for UI display (VTT-style, '.' separator). */
export function formatCueTimestamp(ms: number): string {
  return formatTimestamp(ms, '.')
}

/**
 * Parse SRT content into cues. Tolerates BOM, CRLF/CR line endings, missing or
 * non-numeric index lines, extra blank lines, and multi-line cue text. Cues
 * with unparseable timing are skipped. Output is sorted by start time and
 * re-indexed from 1.
 */
export function parseSrt(srt: string): SubtitleCue[] {
  const normalized = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  const cues: SubtitleCue[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '' || l === '')
    // Drop leading/trailing empties within the block
    while (lines.length && lines[0].trim() === '') lines.shift()
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length === 0) continue

    // Find the timing line (first line containing '-->'); anything before it
    // is an (optional) index, anything after is cue text.
    const timingIdx = lines.findIndex((l) => l.includes('-->'))
    if (timingIdx === -1) continue

    const [rawStart, rawEnd] = lines[timingIdx].split('-->')
    if (rawEnd === undefined) continue
    // VTT-style cue settings after the end timestamp are ignored
    const startMs = parseTimestampMs(rawStart)
    const endMs = parseTimestampMs(rawEnd.trim().split(/\s+/)[0] ?? '')
    if (startMs === null || endMs === null || endMs < startMs) continue

    const text = lines
      .slice(timingIdx + 1)
      .join('\n')
      .trim()
    if (!text) continue

    cues.push({ index: cues.length + 1, startMs, endMs, text })
    if (cues.length >= MAX_CUES) break
  }

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  cues.forEach((c, i) => {
    c.index = i + 1
  })
  return cues
}

export function serializeSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatTimestamp(c.startMs, ',')} --> ${formatTimestamp(c.endMs, ',')}\n${c.text.trim()}`
      )
      .join('\n\n') + '\n'
  )
}

export function serializeVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map(
      (c, i) =>
        `${i + 1}\n${formatTimestamp(c.startMs, '.')} --> ${formatTimestamp(c.endMs, '.')}\n${c.text.trim()}`
    )
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

export function srtToVtt(srt: string): string {
  return serializeVtt(parseSrt(srt))
}

/**
 * Re-flow cue text for on-screen readability: word-wrap each cue to at most
 * `maxCharsPerLine` characters per line and `maxLines` lines. When a cue's text
 * needs more lines than allowed, it is split into multiple cues whose durations
 * are apportioned across the cue's original time range by character count (so
 * nothing is dropped and timing stays roughly in sync). `maxCharsPerLine <= 0`
 * disables wrapping (returns the cues re-indexed but otherwise untouched).
 * Applied at generation time only — manual edits are left as the user typed them.
 */
export function reflowCues(
  cues: SubtitleCue[],
  opts: { maxCharsPerLine: number; maxLines: number },
): SubtitleCue[] {
  const maxChars = Math.floor(opts.maxCharsPerLine)
  const maxLines = Math.max(1, Math.floor(opts.maxLines))
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return cues.map((c, i) => ({ ...c, index: i + 1 }))
  }

  const out: SubtitleCue[] = []
  for (const cue of cues) {
    const words = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
    if (words.length === 0) continue

    // Greedy word-wrap; a single over-long word gets its own line rather than being split.
    const lines: string[] = []
    let cur = ''
    for (const w of words) {
      if (cur === '') cur = w
      else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
      else { lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)

    if (lines.length <= maxLines) {
      out.push({ index: 0, startMs: cue.startMs, endMs: cue.endMs, text: lines.join('\n') })
      continue
    }

    // Overflow: split into groups of `maxLines` lines, time-proportional by char count.
    const groups: string[][] = []
    for (let i = 0; i < lines.length; i += maxLines) groups.push(lines.slice(i, i + maxLines))
    const totalChars = groups.reduce((s, g) => s + g.join(' ').length, 0) || 1
    const dur = Math.max(0, cue.endMs - cue.startMs)
    let t = cue.startMs
    groups.forEach((g, gi) => {
      const chars = g.join(' ').length
      const end = gi === groups.length - 1 ? cue.endMs : Math.min(cue.endMs, t + Math.round((chars / totalChars) * dur))
      out.push({ index: 0, startMs: t, endMs: Math.max(t + 1, end), text: g.join('\n') })
      t = end
    })
  }

  out.forEach((c, i) => { c.index = i + 1 })
  return out
}

/** Normalize cue text for equality checks: lowercase, strip punctuation, collapse whitespace. */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[.,!?;:…"'`~\-—–()]+/g, '')
    .trim()
}

/**
 * Collapse runs of *adjacent* cues with identical (punctuation/case-insensitive)
 * text into a single spanning cue. This neutralizes Whisper's end-of-audio
 * hallucination loop — over trailing silence it repeats a short phrase ("Thank
 * you.") as a flurry of tiny near-zero-duration cues. Only merges when the gap
 * to the next same-text cue is small (`maxGapMs`), so a genuine repeat spoken
 * with a real pause (or the same word far apart in the video) is left alone.
 * Applied at generation time only, like `reflowCues` — manual edits are untouched.
 */
export function collapseRepeatedCues(
  cues: SubtitleCue[],
  opts: { maxGapMs?: number } = {},
): SubtitleCue[] {
  const maxGapMs = opts.maxGapMs ?? 1200
  const out: SubtitleCue[] = []
  for (const cue of cues) {
    const prev = out[out.length - 1]
    const norm = normalizeForCompare(cue.text)
    if (
      prev &&
      norm !== '' &&
      normalizeForCompare(prev.text) === norm &&
      cue.startMs - prev.endMs <= maxGapMs
    ) {
      // Absorb this duplicate into the previous cue's time span.
      prev.endMs = Math.max(prev.endMs, cue.endMs)
      continue
    }
    out.push({ ...cue })
  }
  out.forEach((c, i) => { c.index = i + 1 })
  return out
}

/** Plain-text transcript: cue texts joined into paragraphs, no timestamps. */
export function cuesToTranscriptTxt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((c) => c.text.trim().replace(/\n+/g, ' '))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim() + '\n'
  )
}
