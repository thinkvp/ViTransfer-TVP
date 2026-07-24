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
 * nothing is dropped and timing stays roughly in sync). Splits are refined to
 * sentence boundaries when possible so a new sentence starts on its own cue
 * rather than letting 1–2 orphaned words dangle at the end of the previous
 * cue. A split that would leave a single orphaned word as the final cue instead
 * folds that word back into the previous cue, letting that line exceed
 * `maxCharsPerLine` — a lone word flashing as its own subtitle reads worse than
 * a slightly long line.
 * `maxCharsPerLine <= 0` disables wrapping (returns the cues re-indexed but
 * otherwise untouched).
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

    // Greedy word-wrap; a single over-long word gets its own line rather than
    // being split. Short words (≤3 chars — typically function words like "it",
    // "of", "the") that barely overflow maxChars are pulled back onto the
    // current line: a slight exceedance reads much better than an orphaned "it"
    // dangling at the start of the next subtitle.
    const SHORT_PULLBACK = 6
    const SHORT_PULLBACK_ALLOWANCE = 6
    const lines: string[] = []
    let cur = ''
    for (const w of words) {
      if (cur === '') cur = w
      else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
      else if (
        w.length <= SHORT_PULLBACK &&
        (cur + ' ' + w).length <= maxChars + SHORT_PULLBACK_ALLOWANCE
      ) {
        cur += ' ' + w
      }
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

    // Sentence-boundary refinement: when a group's last line ends with 1–2
    // orphaned words trailing sentence-ending punctuation, move them to the
    // start of the next group so the new sentence starts on its own cue
    // instead of dangling at the end of the previous one.
    for (let gi = 0; gi < groups.length - 1; gi++) {
      const lastLine = groups[gi][groups[gi].length - 1]
      // Find the last . ! or ? followed by space or end-of-line
      const boundaryRe = /[.!?](?=\s|$)/g
      let match: RegExpExecArray | null
      let bestIdx = -1
      while ((match = boundaryRe.exec(lastLine)) !== null) {
        bestIdx = match.index
      }
      if (bestIdx === -1) continue
      const before = lastLine.slice(0, bestIdx + 1).trim()
      const after = lastLine.slice(bestIdx + 1).trim()
      if (!before || !after) continue
      if (after.split(/\s+/).length > 2) continue // too many words — belongs to the current sentence
      groups[gi][groups[gi].length - 1] = before
      groups[gi + 1][0] = after + ' ' + groups[gi + 1][0]
    }

    // Orphan guard: a final group that is just one word folds into the previous
    // group (its last line may exceed maxChars — the lesser evil).
    const last = groups[groups.length - 1]
    if (groups.length > 1 && last.length === 1 && !last[0].includes(' ')) {
      const prev = groups[groups.length - 2]
      prev[prev.length - 1] += ' ' + last[0]
      groups.pop()
    }
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

/**
 * Merge a cue whose entire text is a single word into the previous cue, so a
 * word Whisper segmented off on its own doesn't flash as its own subtitle.
 * Only merges when the gap to the previous cue is small (`maxGapMs`, default
 * 500 ms) — a lone word spoken after a real pause ("...Perfect.") keeps its
 * own cue so the natural gap is visible to the viewer. Skipped when the merge
 * would exceed MAX_CUE_TEXT_LENGTH. Run BEFORE `reflowCues` (which has its
 * own orphan guard for the splits it creates). Applied at generation time
 * only — manual edits are untouched.
 */
export function mergeOrphanWordCues(
  cues: SubtitleCue[],
  opts: { maxGapMs?: number } = {},
): SubtitleCue[] {
  const maxGapMs = opts.maxGapMs ?? 500
  const out: SubtitleCue[] = []
  for (const cue of cues) {
    const prev = out[out.length - 1]
    const text = cue.text.trim()
    if (
      prev &&
      text !== '' &&
      !/\s/.test(text) &&
      cue.startMs - prev.endMs <= maxGapMs &&
      prev.text.length + 1 + text.length <= MAX_CUE_TEXT_LENGTH
    ) {
      prev.text = `${prev.text} ${text}`
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

// ---------------------------------------------------------------------------
// Build cues from word-level timestamps (OpenAI verbose_json)
// ---------------------------------------------------------------------------

/** A single word with timing in seconds (from Whisper verbose_json). */
export interface TimedWord {
  word: string
  start: number // seconds
  end: number   // seconds
}

/**
 * Build subtitle cues directly from word-level timestamps. Words are grouped
 * into lines (greedy word-wrap with the same pullback tolerance as reflowCues)
 * and lines into cues (maxLines per cue). Each cue's start/end comes from the
 * actual word timestamps of its first/last word — no character-count
 * approximation. This replaces Whisper's coarse segment-level SRT timestamps
 * with word-precise timing.
 *
 * The returned cues are already sized to fit `maxCharsPerLine` × `maxLines`,
 * so running them through `reflowCues` afterwards is a near-no-op (splits are
 * rare; the primary purpose of the follow-up reflowCues pass is sentence-
 * boundary refinement and orphan folding).
 */
export function buildCuesFromWords(
  allWords: TimedWord[],
  opts: { maxCharsPerLine: number; maxLines: number },
): SubtitleCue[] {
  const maxChars = Math.floor(opts.maxCharsPerLine)
  const maxLines = Math.max(1, Math.floor(opts.maxLines))
  const SHORT_PULLBACK = 6
  const SHORT_PULLBACK_ALLOWANCE = 6

  if (!Number.isFinite(maxChars) || maxChars <= 0 || allWords.length === 0) {
    if (allWords.length === 0) return []
    // No wrapping — single cue spanning all words
    return [{
      index: 1,
      startMs: Math.round(allWords[0].start * 1000),
      endMs: Math.round(allWords[allWords.length - 1].end * 1000),
      text: allWords.map(w => w.word).join(' '),
    }]
  }

  const cues: SubtitleCue[] = []
  let i = 0

  while (i < allWords.length) {
    const cueLines: string[] = []
    let cueStartMs = Math.round(allWords[i].start * 1000)
    let cueEndWordIdx = i // track the last word included in this cue

    // Build up to maxLines lines for this cue
    for (let lineNum = 0; lineNum < maxLines && i < allWords.length; lineNum++) {
      let curLine = ''
      let lineWordCount = 0

      // Fill one line greedily (same logic as reflowCues word-wrap)
      while (i < allWords.length) {
        const w = allWords[i]
        if (curLine === '') {
          curLine = w.word
          lineWordCount = 1
          cueEndWordIdx = i
          i++
        } else if ((curLine + ' ' + w.word).length <= maxChars) {
          curLine += ' ' + w.word
          lineWordCount++
          cueEndWordIdx = i
          i++
        } else if (
          w.word.length <= SHORT_PULLBACK &&
          (curLine + ' ' + w.word).length <= maxChars + SHORT_PULLBACK_ALLOWANCE
        ) {
          curLine += ' ' + w.word
          lineWordCount++
          cueEndWordIdx = i
          i++
        } else {
          break // line is full
        }
      }

      if (curLine) cueLines.push(curLine)

      // If we consumed no words this iteration, break to avoid infinite loop
      if (lineWordCount === 0) break
    }

    if (cueLines.length === 0) continue

    const lastWord = allWords[cueEndWordIdx]
    cues.push({
      index: cues.length + 1,
      startMs: cueStartMs,
      endMs: Math.round(lastWord.end * 1000),
      text: cueLines.join('\n'),
    })
  }

  return cues
}
