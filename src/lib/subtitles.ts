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

/**
 * Filename marker carried by captions nobody has signed off on. The point is to
 * survive leaving the app: once a file sits in someone's Downloads folder the UI
 * caveat is gone, so the caveat travels in the name. Added whenever cues are
 * written, stripped when an admin marks them checked (see lib/subtitle-delivery).
 */
export const AUTO_DRAFT_MARKER = '_AUTO-DRAFT'

export function hasDraftMarker(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  return stem.endsWith(AUTO_DRAFT_MARKER)
}

/**
 * Add or strip the draft marker, preserving the extension. Idempotent in both
 * directions, so callers can apply it to a name of unknown provenance (a
 * hand-uploaded SRT that was promoted, say) without accumulating markers.
 */
export function applyDraftMarker(fileName: string, isDraft: boolean): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  const bare = stem.endsWith(AUTO_DRAFT_MARKER) ? stem.slice(0, -AUTO_DRAFT_MARKER.length) : stem
  return `${bare}${isDraft ? AUTO_DRAFT_MARKER : ''}${ext}`
}

/**
 * Word-wrap tolerance shared by every wrapper here: a short word (<= 6 chars —
 * "it", "of", "the") that only just overflows the line is pulled back onto it,
 * because a slightly long line reads better than an orphaned "it" opening the
 * next one.
 */
const SHORT_PULLBACK = 6
const SHORT_PULLBACK_ALLOWANCE = 6

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
    // being split. Short words (≤6 chars — small function/filler words like
    // "it", "of", "the", "really") that barely overflow maxChars are pulled
    // back onto the current line: a slight exceedance reads much better than
    // an orphaned "it" dangling at the start of the next subtitle.
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
 * Re-attach punctuation to a word stream using the full transcript text.
 *
 * OpenAI's word-level timestamps arrive stripped of punctuation — "Well" where
 * the transcript says "Well," — so cues built straight from `words[]` read as
 * one long unpunctuated run. faster-whisper/Speaches instead returns each word
 * with its punctuation already attached. This aligns the word stream against
 * the punctuated transcript and gives every word back its own punctuation, so
 * cue text matches the transcript while timing still comes from the words.
 *
 * Alignment is positional over alphanumerics only, so it is unaffected by the
 * punctuation and casing differences it exists to repair, and it is idempotent:
 * running it over words that already carry punctuation reproduces them. If the
 * two streams disagree badly (under 90% of words located, i.e. not the same
 * audio or an unexpected response shape) the original words are returned
 * untouched — captions with flat punctuation beat captions with wrong words.
 */
export function attachPunctuationFromTranscript(words: TimedWord[], transcript: string): TimedWord[] {
  if (words.length === 0 || !transcript.trim()) return words

  // Normalised (alphanumeric, lowercase) projection of the transcript, with an
  // index back to each character's position in the original string.
  let norm = ''
  const originalIndex: number[] = []
  for (let i = 0; i < transcript.length; i++) {
    const ch = transcript[i]
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch.toLowerCase()
      originalIndex.push(i)
    }
  }
  if (norm === '') return words

  // Locate each word's core span in the transcript, walking forward only.
  const MAX_LOOKAHEAD = 200
  const spans: ({ start: number; end: number } | null)[] = []
  let cursor = 0
  let matched = 0
  for (const w of words) {
    const wn = w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (wn === '') {
      spans.push(null)
      continue
    }
    const at = norm.indexOf(wn, cursor)
    if (at === -1 || at > cursor + MAX_LOOKAHEAD) {
      spans.push(null)
      continue
    }
    spans.push({ start: originalIndex[at], end: originalIndex[at + wn.length - 1] + 1 })
    cursor = at + wn.length
    matched++
  }

  // Punctuation-only tokens ("%") have nothing to locate and don't count.
  const locatable = words.filter((w) => /[\p{L}\p{N}]/u.test(w.word)).length
  if (matched < locatable * 0.9) return words

  // Hand the text between spans to its neighbours: everything up to the first
  // whitespace trails the previous word (a comma), everything after the last
  // whitespace leads the next one (an opening quote or bracket). Each gap is
  // assigned once, so nothing doubles up.
  //
  // Whisper tokenises some single written words into several timed tokens —
  // "platform" + "-based", "40" + "%", "once" + "-in" + "-a" + "-generation".
  // Where the transcript has no whitespace between two tokens they are one
  // word on screen, so they merge into one timed word (first start, last end):
  // otherwise a caption reads "platform- based", or breaks inside the word.
  // A punctuation-only token ("%") has no span of its own; the transcript gap
  // already supplies its text, so only its timing is kept.
  const out: TimedWord[] = []
  let prevEnd = 0
  let prevOut = -1 // index in `out` of the last matched word
  for (let i = 0; i < words.length; i++) {
    const span = spans[i]
    const w = words[i]
    if (!span) {
      if (w.word.replace(/[^\p{L}\p{N}]/gu, '') === '') {
        if (out.length > 0) out[out.length - 1].end = Math.max(out[out.length - 1].end, w.end)
        continue
      }
      out.push({ ...w }) // an unmatched real word keeps its own text
      continue
    }

    const gap = transcript.slice(prevEnd, span.start)
    const text = transcript.slice(span.start, span.end)
    prevEnd = span.end

    if (prevOut >= 0 && prevOut === out.length - 1 && !/\s/.test(gap)) {
      out[prevOut].word += gap + text
      out[prevOut].end = Math.max(out[prevOut].end, w.end)
      continue
    }

    let lead = ''
    if (gap !== '') {
      const firstWs = gap.search(/\s/)
      if (firstWs === -1) {
        if (prevOut >= 0) out[prevOut].word += gap
        else lead = gap
      } else {
        if (prevOut >= 0) out[prevOut].word += gap.slice(0, firstWs)
        // Whatever is left leads this word. Internal spacing is kept, so a
        // free-standing token (an em dash, an ellipsis) survives as its own
        // word rather than being dropped with the whitespace around it.
        lead = gap.slice(firstWs).replace(/^\s+/, '')
      }
    }
    out.push({ ...w, word: lead + text })
    prevOut = out.length - 1
  }

  // Punctuation directly after the final matched word (the closing full stop).
  // Punctuation only, and only what is adjacent: any words still left in the
  // transcript were never matched to a timing, and putting them on screen would
  // show text the cue timings never accounted for.
  if (prevOut >= 0) {
    const tail = /^\s*([^\p{L}\p{N}\s]+)/u.exec(transcript.slice(prevEnd))
    if (tail) out[prevOut].word += tail[1]
  }

  return out
}

/**
 * The same merge for a stream that never went through
 * {@link attachPunctuationFromTranscript} (it bailed out on a poor match).
 * faster-whisper marks a token that continues the previous word by omitting
 * its leading space (" platform", "-based"), so that is used instead — but only
 * when the stream follows that convention at all: OpenAI's words (and words
 * that went through the transcript pass) carry no spaces, and every one of
 * them would otherwise merge into one.
 */
function mergeContinuationTokens(words: TimedWord[]): TimedWord[] {
  if (!words.some((w) => /^\s/.test(w.word))) return words
  const out: TimedWord[] = []
  for (const w of words) {
    const prev = out[out.length - 1]
    if (prev && !/^\s/.test(w.word) && w.word !== '') {
      prev.word += w.word
      prev.end = Math.max(prev.end, w.end)
    } else {
      out.push({ ...w })
    }
  }
  return out
}

/**
 * Does this word close a sentence? Used to place cue boundaries where a reader
 * would pause. Deliberately conservative: an ellipsis is a hesitation rather
 * than a full stop, and a lone initial or a common abbreviation ("Dr.", "St.")
 * takes a period without ending anything.
 */
function endsSentence(raw: string): boolean {
  const w = raw.trim()
  if (w === '') return false
  if (/(\.\.\.|…)["'”’)\]]*$/.test(w)) return false
  if (/^\p{L}\.$/u.test(w)) return false
  if (/^(mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|approx|dept|no)\.$/i.test(w)) return false
  return /[.!?]["'”’)\]]*$/.test(w)
}

/**
 * Words a caption line should not end on, because each one only makes sense
 * with what follows it: articles and possessives ("the", "our"), the
 * prepositions that open a noun phrase ("of", "with"), conjunctions ("and",
 * "because"), and the subject-only pronouns ("I", "we"). Particles that can
 * close a phrase ("in", "up", "on" — "log on", "turn it up") and words that are
 * just as often objects or pronouns ("you", "it", "that", "her") are
 * deliberately left out: a false positive here moves a break that was fine.
 */
const WEAK_ENDINGS = new Set([
  'a', 'an', 'the',
  'my', 'your', 'our', 'their', 'its',
  'of', 'to', 'for', 'with', 'from', 'at', 'into', 'onto', 'by', 'than', 'via', 'per',
  'and', 'but', 'or', 'nor', 'because', 'although', 'unless', 'whether', 'if',
  'i', 'we', 'they', 'he', 'she',
  // "is"/"as" close a clause only before punctuation ("that's what it is."),
  // and a word carrying punctuation is never treated as weak.
  'is', 'are', 'was', 'were', 'am', 'as',
  // Auxiliaries and modals lean on their verb the same way ("has | logged in").
  'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'must', 'might', 'may', 'shall',
  'do', 'does', 'did', 'be', 'been',
  // Contracted "is" never closes a clause ("I think it's" needs its "going").
  "it's", "that's", "there's", "here's", "what's", "where's", "who's", "he's", "she's", "let's",
])

/** Words a new caption reads well opening with: conjunctions and relatives start a clause. */
const CLAUSE_OPENERS = new Set([
  'and', 'but', 'or', 'so', 'because', 'although', 'though', 'unless', 'until', 'whether', 'if',
  'which', 'who', 'whose', 'where', 'when', 'while',
])

/**
 * Prepositions and determiners start a phrase — a weaker but still clean place
 * to begin a caption. "in", "on" and "like" are left out: as often as not they
 * finish a phrasal verb ("logged in") rather than start anything.
 */
const PHRASE_OPENERS = new Set([
  'of', 'to', 'for', 'with', 'from', 'at', 'by', 'about', 'into', 'onto', 'through',
  'after', 'before', 'during', 'without', 'across', 'between',
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its', 'this', 'that', 'these', 'those',
])

/**
 * Prepositions — including the particle-or-preposition ones left out of
 * WEAK_ENDINGS. Followed by a determiner or a relative ("in the", "in which")
 * they are unmistakably prepositions, and so weak endings after all.
 */
const PREPOSITIONS = new Set([
  'of', 'to', 'for', 'with', 'from', 'at', 'by', 'about', 'into', 'onto', 'through',
  'after', 'before', 'during', 'without', 'across', 'between',
  'in', 'on', 'over', 'under', 'around', 'behind', 'inside', 'near', 'like',
])
const DETERMINERS_AND_RELATIVES = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its', 'his', 'her', 'this', 'that', 'these', 'those',
  'which', 'whom', 'whose', 'what',
])

/** Lowercased word with surrounding punctuation stripped and curly apostrophes straightened. */
function bareWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
}

/**
 * Would a line ending on this word leave it hanging? True for the words above
 * and for any contracted "are/have/will/would/am" ("we're", "I'll") — none of
 * which can close a clause. A word carrying its own trailing punctuation is a
 * break by definition ("and," is fine); a trailing hyphen is not ("once-").
 */
function isWeakEnding(raw: string): boolean {
  const w = raw.trim()
  if (/-$/.test(w)) return true
  if (!/[\p{L}\p{N}]$/u.test(w)) return false
  const bare = bareWord(w)
  return WEAK_ENDINGS.has(bare) || /'(re|ve|ll|d|m)$/.test(bare)
}

/** How many characters words[from..to] occupy once joined onto one line. */
function rangeLength(words: TimedWord[], from: number, to: number): number {
  let len = 0
  for (let i = from; i <= to; i++) len += words[i].word.length + (i > from ? 1 : 0)
  return len
}

/**
 * Does this word close a clause? A comma, semicolon, colon, dash or ellipsis is
 * a weaker break than a full stop but still a place a reader pauses.
 */
function endsClause(raw: string): boolean {
  const w = raw.trim()
  if (w === '') return false
  return /([,;:–—]|\.\.\.|…)["'”’)\]]*$/.test(w)
}

/** How far a whole sentence may overrun the cue budget to stay in one cue rather than be split. */
const SENTENCE_OVERFLOW_ALLOWANCE = 10
/** A gap this long between two words is a spoken pause — as good a place to break as a comma. */
const PAUSE_BREAK_MS = 350

/**
 * What it costs to end a cue or a line after a given word; lower is better.
 * The scale only matters relative to BALANCE_WEIGHT / OVERRUN_COST /
 * EXTRA_PIECE_COST below: a weak ending costs more than a lopsided split, a
 * plain break about as much as a moderately uneven one.
 */
const BREAK_COST = {
  sentence: 0,
  clause: 1,
  pause: 1,
  beforeClauseOpener: 2, // "…hearing aids | which is…"
  beforePhraseOpener: 3, // "…the capital | of the nation"
  plain: 8,
  weak: 30, // "…our state the | building"
} as const
/** Weight of a piece's squared deviation from an even split, relative to its budget. */
const BALANCE_WEIGHT = 20
/** Cost per character a piece runs past its budget (up to the short-word allowance). */
const OVERRUN_COST = 0.5
/** Cost of each cue or line beyond the fewest the text could fit in. */
const EXTRA_PIECE_COST = 4
/** Above this many pieces a stretch is halved before being split (bounds the partition table). */
const MAX_PARTITION_PIECES = 24

function breakCost(words: TimedWord[], k: number): number {
  if (k >= words.length - 1) return 0
  const w = words[k].word
  if (endsSentence(w)) return BREAK_COST.sentence
  if (isWeakEnding(w)) return BREAK_COST.weak
  if (endsClause(w)) return BREAK_COST.clause
  const opener = bareWord(words[k + 1].word)
  // "…different ways in | which", "…the speech in | the environment"
  if (PREPOSITIONS.has(bareWord(w)) && DETERMINERS_AND_RELATIVES.has(opener)) return BREAK_COST.weak
  if ((words[k + 1].start - words[k].end) * 1000 >= PAUSE_BREAK_MS) return BREAK_COST.pause
  if (CLAUSE_OPENERS.has(opener)) return BREAK_COST.beforeClauseOpener
  if (PHRASE_OPENERS.has(opener)) return BREAK_COST.beforePhraseOpener
  return BREAK_COST.plain
}

/**
 * Split words[from..to] into consecutive pieces of at most `hardMax`
 * characters (a single over-long word may stand alone), picking the split with
 * the lowest total cost: where each break falls (breakCost), how evenly the
 * pieces share the text, how far any runs past `softMax`, and how many pieces
 * it takes. Tries the fewest pieces that can fit plus two more, capped at
 * `maxPieces`. Returns the index of each piece's last word, or null when even
 * the fewest exceeds `maxPieces`.
 *
 * Evening the pieces out is what keeps a long sentence from ending on a scrap
 * ("…when there" / "was no conversation."): greedy filling makes every piece
 * full except the last.
 */
function partitionWords(
  words: TimedWord[],
  from: number,
  to: number,
  softMax: number,
  hardMax: number,
  maxPieces: number,
): number[] | null {
  const n = to - from + 1
  // prefix[i] = characters in words[from..from+i-1], spaces excluded.
  const prefix = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + words[from + i].word.length
  const len = (a: number, b: number) => prefix[b + 1] - prefix[a] + (b - a) // relative indices, inclusive
  const breaks = Array.from({ length: n }, (_, i) => (i < n - 1 ? breakCost(words, from + i) : 0))

  // Greedy fill gives the true minimum piece count (and a split that always fits).
  const greedyEnds: number[] = []
  for (let start = 0; start < n; ) {
    let end = start
    while (end + 1 < n && len(start, end + 1) <= hardMax) end++
    greedyEnds.push(from + end)
    start = end + 1
  }
  const fewest = greedyEnds.length
  if (fewest > maxPieces) return null

  // A very long unpunctuated stretch (a run-on transcript) would make the
  // table below pieces × words in size: cut it at the cheapest break near a
  // greedy boundary and solve the halves on their own.
  if (fewest > MAX_PARTITION_PIECES) {
    const boundary = greedyEnds[Math.floor(fewest / 2)] - from
    let cut = boundary
    for (let i = boundary; i > Math.max(0, boundary - 5); i--) if (breaks[i] < breaks[cut]) cut = i
    return [
      ...(partitionWords(words, from, from + cut, softMax, hardMax, Infinity) ?? []),
      ...(partitionWords(words, from + cut + 1, to, softMax, hardMax, Infinity) ?? []),
    ]
  }

  const total = len(0, n - 1)
  let best: { cost: number; ends: number[] } | null = null
  for (let p = fewest; p <= Math.min(maxPieces, fewest + 2, n); p++) {
    const target = total / p
    // cost[q][i]: cheapest way to cover relative words 0..i with q pieces.
    const cost: Float64Array[] = Array.from({ length: p + 1 }, () => new Float64Array(n).fill(Infinity))
    const back: Int32Array[] = Array.from({ length: p + 1 }, () => new Int32Array(n).fill(-1))
    for (let q = 1; q <= p; q++) {
      for (let i = q - 1; i < n; i++) {
        // Piece q covers words j+1..i; j is where piece q-1 ended (-1 for the first).
        for (let j = q === 1 ? -1 : i - 1; j >= (q === 1 ? -1 : q - 2); j--) {
          const l = len(j + 1, i)
          if (l > hardMax && i > j + 1) break // only longer from here on
          const before = q === 1 ? 0 : cost[q - 1][j]
          if (before === Infinity) continue
          const c =
            before +
            BALANCE_WEIGHT * ((l - target) / softMax) ** 2 +
            OVERRUN_COST * Math.max(0, l - softMax) +
            breaks[i]
          if (c < cost[q][i]) {
            cost[q][i] = c
            back[q][i] = j
          }
        }
      }
    }
    const splitCost = cost[p][n - 1] + EXTRA_PIECE_COST * (p - fewest)
    if (splitCost === Infinity || (best && splitCost >= best.cost)) continue
    const ends: number[] = []
    for (let q = p, i = n - 1; q >= 1; i = back[q][i], q--) ends.unshift(from + i)
    best = { cost: splitCost, ends }
  }

  return best?.ends ?? greedyEnds
}

/**
 * Lay out words[from..to] as the lines of one cue: a single line when it fits
 * (or when only one line is allowed), otherwise the cheapest split into at most
 * `maxLines` lines by the same rules as cue breaks — so a line ends at a comma
 * or a sentence end rather than on "the". Falls back to a greedy wrap whose
 * last line absorbs the remainder when no split fits.
 */
function layoutLines(words: TimedWord[], from: number, to: number, maxChars: number, maxLines: number): string[] {
  const join = (a: number, b: number) => words.slice(a, b + 1).map((w) => w.word).join(' ')
  if (maxLines === 1 || rangeLength(words, from, to) <= maxChars) return [join(from, to)]

  const ends = partitionWords(words, from, to, maxChars, maxChars + SHORT_PULLBACK_ALLOWANCE, maxLines)
  if (ends) {
    let start = from
    return ends.map((end) => {
      const line = join(start, end)
      start = end + 1
      return line
    })
  }

  const lines: string[] = []
  let cur = ''
  for (let i = from; i <= to; i++) {
    const w = words[i].word
    if (cur === '') cur = w
    else if ((cur + ' ' + w).length <= maxChars || lines.length + 1 >= maxLines) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur !== '') lines.push(cur)
  return lines
}

/**
 * Build subtitle cues directly from word-level timestamps. Each cue's
 * start/end comes from the actual timestamps of its first/last word — no
 * character-count approximation — so moving a break never changes timing
 * accuracy, only which words share a cue.
 *
 * 1. The word stream is split into pause-delimited runs (`maxWordGapMs`,
 *    default 800 ms) so a cue never straddles a real silence.
 * 2. Each run is split into sentences. A cue never runs from the end of one
 *    sentence into the start of the next: consecutive whole sentences share a
 *    cue only when they fit together ("Very good. Yes."), and a sentence that
 *    fits the budget (+`SENTENCE_OVERFLOW_ALLOWANCE`) is kept whole.
 * 3. A longer sentence is divided by `partitionWords` into evenly sized cues,
 *    breaking at commas and pauses, before "and"/"which"/"of", and never after
 *    a weak word ("the", "I", "it's") when there is any alternative.
 * 4. Each cue's lines are laid out by the same rules (`layoutLines`).
 *
 * `maxCharsPerLine <= 0` disables wrapping: each pause-delimited run becomes
 * one cue (never a single cue spanning the whole video — callers wanting the
 * old segment shape should build cues from Whisper's segments instead).
 *
 * Callers must NOT pass the result through `reflowCues`: it would re-split any
 * over-budget cue with character-count timing.
 */
export function buildCuesFromWords(
  allWords: TimedWord[],
  opts: { maxCharsPerLine: number; maxLines: number; maxWordGapMs?: number },
): SubtitleCue[] {
  const maxChars = Math.floor(opts.maxCharsPerLine)
  const maxLines = Math.max(1, Math.floor(opts.maxLines))
  const maxWordGapMs = opts.maxWordGapMs ?? 800

  if (allWords.length === 0) return []

  // faster-whisper returns words with a leading space (" Well,"). Normalise once
  // here: these cues are emitted as-is, with no re-flow pass downstream to tidy
  // up double spaces.
  const allWordsTrimmed = mergeContinuationTokens(allWords)
    .map((w) => ({ ...w, word: w.word.trim() }))
    .filter((w) => w.word !== '')

  // Split into pause-delimited runs: a gap larger than maxWordGapMs between
  // consecutive words always starts a new run (and therefore a new cue).
  const runs: TimedWord[][] = []
  let run: TimedWord[] = []
  for (const w of allWordsTrimmed) {
    const prev = run[run.length - 1]
    if (prev && (w.start - prev.end) * 1000 > maxWordGapMs) {
      runs.push(run)
      run = []
    }
    run.push(w)
  }
  if (run.length > 0) runs.push(run)

  const wrappingEnabled = Number.isFinite(maxChars) && maxChars > 0
  const budget = maxChars * maxLines
  const cues: SubtitleCue[] = []

  for (const words of runs) {
    const pushCue = (from: number, to: number, lines: string[]) => {
      cues.push({
        index: cues.length + 1,
        startMs: Math.round(words[from].start * 1000),
        endMs: Math.round(words[to].end * 1000),
        text: lines.join('\n'),
      })
    }

    if (!wrappingEnabled) {
      // No wrapping — one cue per pause-delimited run.
      pushCue(0, words.length - 1, [words.map((w) => w.word).join(' ')])
      continue
    }

    // Sentences as [first, last] word indices; a run's unpunctuated tail counts as one.
    const sentences: [number, number][] = []
    let sentenceStart = 0
    for (let k = 0; k < words.length; k++) {
      if (endsSentence(words[k].word) || k === words.length - 1) {
        sentences.push([sentenceStart, k])
        sentenceStart = k + 1
      }
    }

    const emit = (from: number, to: number) => pushCue(from, to, layoutLines(words, from, to, maxChars, maxLines))

    for (let si = 0; si < sentences.length; si++) {
      const [first, last] = sentences[si]
      if (rangeLength(words, first, last) <= budget + SENTENCE_OVERFLOW_ALLOWANCE) {
        let end = last
        while (si + 1 < sentences.length && rangeLength(words, first, sentences[si + 1][1]) <= budget) {
          si++
          end = sentences[si][1]
        }
        emit(first, end)
        continue
      }
      const ends = partitionWords(words, first, last, budget, budget + SHORT_PULLBACK_ALLOWANCE, Infinity)
      let from = first
      for (const end of ends ?? [last]) {
        emit(from, end)
        from = end + 1
      }
    }
  }

  return cues
}
