/**
 * Long-audio chunking for Whisper.
 *
 * Whisper decodes in 30-second windows, each conditioned on the text it just
 * wrote. On a long recording that conditioning can derail for good: one window
 * comes out unpunctuated or skips words, the following windows copy it, and
 * the rest of the file never recovers (seen on a 52-minute presentation whose
 * captions lost every full stop and dropped words from ~40 minutes on). Sending
 * the audio in independent pieces bounds that damage to one piece.
 *
 * No `prompt` is sent with the pieces. A punctuated example prompt was tried to
 * keep each piece's punctuation going and it backfired: it tipped a piece into
 * a "Thank you." loop that dropped a whole 20-second clip, which the same audio
 * without the prompt transcribed cleanly.
 *
 * Pure planning + stitching only — ffmpeg and HTTP live in the worker.
 */
import type { WhisperVerboseJsonResponse, WhisperVerboseSegment, WhisperWord } from './whisper'

/** Audio at or under this length is sent whole — one request, as before. */
export const CHUNK_THRESHOLD_SEC = 15 * 60
/** Aim for pieces about this long. */
export const CHUNK_TARGET_SEC = 10 * 60
/** How far either side of the target a cut may move to land in a silence. */
export const CHUNK_SEARCH_SEC = 2 * 60
/** Audio kept either side of a cut, inside the silence, so no word edge is clipped. */
const CUT_PAD_SEC = 0.25

export interface TranscriptionChunk {
  /** Start of this piece in the full audio (seconds) — the offset added back to its timestamps. */
  startSec: number
  /** End of this piece in the full audio (seconds). */
  endSec: number
}

export interface SilenceSpan {
  startSec: number
  endSec: number
}

/**
 * Split `durationSec` of audio into pieces of about `targetSec`, cutting inside
 * the longest silence within `searchSec` of each target. The middle of that
 * silence is left out of both pieces (each keeps `CUT_PAD_SEC` of it), so
 * Whisper is never handed a long stretch of trailing silence to hallucinate
 * over. With no silence in reach, the search widens to half the target either
 * side; only with none there either does the cut fall on the target itself,
 * which can split one word.
 */
export function planTranscriptionChunks(
  durationSec: number,
  silences: SilenceSpan[],
  opts: { thresholdSec?: number; targetSec?: number; searchSec?: number } = {},
): TranscriptionChunk[] {
  const thresholdSec = opts.thresholdSec ?? CHUNK_THRESHOLD_SEC
  const targetSec = opts.targetSec ?? CHUNK_TARGET_SEC
  const searchSec = opts.searchSec ?? CHUNK_SEARCH_SEC

  if (!(durationSec > 0)) return []
  if (durationSec <= thresholdSec) return [{ startSec: 0, endSec: durationSec }]

  const sorted = [...silences].sort((a, b) => a.startSec - b.startSec)
  const chunks: TranscriptionChunk[] = []
  let cursor = 0

  const pickSilence = (cursor: number, ideal: number, reach: number): SilenceSpan | null => {
    let best: SilenceSpan | null = null
    for (const s of sorted) {
      const mid = (s.startSec + s.endSec) / 2
      if (mid <= cursor + targetSec / 2 || Math.abs(mid - ideal) > reach) continue
      const len = s.endSec - s.startSec
      const bestLen = best ? best.endSec - best.startSec : -1
      // Longest silence wins; a tie goes to the one nearer the target.
      if (len > bestLen || (len === bestLen && best && Math.abs(mid - ideal) < Math.abs((best.startSec + best.endSec) / 2 - ideal))) {
        best = s
      }
    }
    return best
  }

  // Stop cutting once what's left fits in one comfortable piece.
  while (durationSec - cursor > targetSec * 1.5) {
    const ideal = cursor + targetSec
    // Music or applause can run for minutes with no silence near the target;
    // look further out (piece lengths up to 1.5× the target) before hard-cutting.
    const best = pickSilence(cursor, ideal, searchSec) ?? pickSilence(cursor, ideal, Math.max(searchSec, targetSec / 2))

    if (best) {
      const pad = Math.min(CUT_PAD_SEC, (best.endSec - best.startSec) / 2)
      chunks.push({ startSec: cursor, endSec: best.startSec + pad })
      cursor = best.endSec - pad
    } else {
      chunks.push({ startSec: cursor, endSec: ideal })
      cursor = ideal
    }
  }
  chunks.push({ startSec: cursor, endSec: durationSec })
  return chunks
}

/**
 * A piece whose transcript runs this many words without a full stop, comma,
 * question or exclamation mark has lost its punctuation — normal speech never
 * goes that long. It's the visible sign of a derailed decode, and it usually
 * comes with dropped words that can't be detected directly.
 */
export const UNPUNCTUATED_RUN_LIMIT = 50
/** Pieces shorter than this are never split again. */
export const MIN_SPLIT_SEC = 60

/** Longest stretch of words in `text` with no punctuation between them. */
export function longestUnpunctuatedRun(text: string): number {
  let longest = 0
  let run = 0
  for (const token of text.split(/\s+/)) {
    if (!/[\p{L}\p{N}]/u.test(token)) continue
    run++
    if (/[.,?!;:…]/.test(token)) {
      longest = Math.max(longest, run)
      run = 0
    }
  }
  return Math.max(longest, run)
}

/**
 * A stretch of a piece this long with sound but no transcribed words is either
 * music or speech Whisper skipped. The two can't be told apart from levels
 * alone, so it's worth a retry, which the score below then judges.
 */
export const UNHEARD_STRETCH_LIMIT_SEC = 45

/** Words in a transcript (tokens with a letter or digit). */
export function transcriptWordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length
}

/**
 * Longest stretch of a piece with sound but no words: the gaps between words
 * (and before the first / after the last) minus the silences inside them.
 * `words` are piece-relative, as Whisper returns them; `silences` are on the
 * full audio's timeline.
 */
export function longestUnheardStretch(chunk: TranscriptionChunk, words: WhisperWord[], silences: SilenceSpan[]): number {
  const len = chunk.endSec - chunk.startSec
  const quiet = silences
    .map((s) => ({ startSec: Math.max(0, s.startSec - chunk.startSec), endSec: Math.min(len, s.endSec - chunk.startSec) }))
    .filter((s) => s.endSec > s.startSec)
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const gaps: [number, number][] = []
  let prevEnd = 0
  for (const w of sorted) {
    if (w.start > prevEnd) gaps.push([prevEnd, w.start])
    prevEnd = Math.max(prevEnd, w.end)
  }
  if (len > prevEnd) gaps.push([prevEnd, len])

  let longest = 0
  for (const [a, b] of gaps) {
    let silent = 0
    for (const s of quiet) silent += Math.max(0, Math.min(b, s.endSec) - Math.max(a, s.startSec))
    longest = Math.max(longest, b - a - silent)
  }
  return longest
}

/**
 * How good a piece's transcript is, for choosing between a piece and its split
 * retry: one point per word, less two for every word of unpunctuated run past
 * the limit. More words wins (skipped speech recovered); a derailed,
 * unpunctuated piece loses even when its word count holds up.
 */
export function transcriptScore(text: string): number {
  return transcriptWordCount(text) - 2 * Math.max(0, longestUnpunctuatedRun(text) - UNPUNCTUATED_RUN_LIMIT)
}

/**
 * Split a piece in two for a fresh retry, inside the longest silence in its
 * middle half (so neither half is tiny), else at the midpoint.
 */
export function splitTranscriptionChunk(chunk: TranscriptionChunk, silences: SilenceSpan[]): [TranscriptionChunk, TranscriptionChunk] {
  const len = chunk.endSec - chunk.startSec
  const lo = chunk.startSec + len / 4
  const hi = chunk.endSec - len / 4
  let best: SilenceSpan | null = null
  for (const s of silences) {
    const mid = (s.startSec + s.endSec) / 2
    if (mid < lo || mid > hi) continue
    if (!best || s.endSec - s.startSec > best.endSec - best.startSec) best = s
  }
  if (!best) {
    const mid = chunk.startSec + len / 2
    return [{ startSec: chunk.startSec, endSec: mid }, { startSec: mid, endSec: chunk.endSec }]
  }
  const pad = Math.min(CUT_PAD_SEC, (best.endSec - best.startSec) / 2)
  return [{ startSec: chunk.startSec, endSec: best.startSec + pad }, { startSec: best.endSec - pad, endSec: chunk.endSec }]
}

/** Shift a word by `offsetSec`, clamped to its piece so pieces never overlap. */
function shiftWord(w: WhisperWord, offsetSec: number, endSec: number): WhisperWord {
  const start = Math.min(w.start + offsetSec, endSec)
  const end = Math.max(start, Math.min(w.end + offsetSec, endSec))
  return { ...w, start, end }
}

/**
 * Join per-piece verbose_json responses into one response on the full audio's
 * timeline: every timestamp gets its piece's start added back, segment ids run
 * on, and the texts join with a space. The result has the same shape the
 * single-request path produces, so everything downstream is unchanged.
 */
export function stitchVerboseResponses(
  parts: { chunk: TranscriptionChunk; response: WhisperVerboseJsonResponse }[],
): WhisperVerboseJsonResponse {
  if (parts.length === 1 && parts[0].chunk.startSec === 0) return parts[0].response

  const segments: WhisperVerboseSegment[] = []
  const words: WhisperWord[] = []
  const texts: string[] = []
  let anySegments = false
  let anyWords = false

  for (const { chunk, response } of parts) {
    const offset = chunk.startSec
    const end = chunk.endSec
    if (response.segments) {
      anySegments = true
      for (const s of response.segments) {
        const start = Math.min(s.start + offset, end)
        segments.push({
          ...s,
          id: segments.length,
          start,
          end: Math.max(start, Math.min(s.end + offset, end)),
          words: s.words?.map((w) => shiftWord(w, offset, end)),
        })
      }
    }
    if (response.words) {
      anyWords = true
      words.push(...response.words.map((w) => shiftWord(w, offset, end)))
    }
    const text = response.text?.trim()
    if (text) texts.push(text)
  }

  const last = parts[parts.length - 1]
  return {
    task: parts[0]?.response.task ?? 'transcribe',
    language: parts[0]?.response.language ?? '',
    duration: last ? last.chunk.endSec : 0,
    text: texts.join(' '),
    ...(anySegments ? { segments } : {}),
    ...(anyWords ? { words } : {}),
  }
}
