/**
 * Transcription dry-run — exercises the SRT/VTT subtitle layer without a DB.
 *
 *   npx tsx scripts/transcription-dry-run.ts
 *
 * PASS/FAIL checks for parseSrt/serializeSrt/serializeVtt round-trips (CRLF,
 * BOM, multi-line text, missing indices, out-of-order cues, junk blocks) and
 * the transcript export. Optionally, set TRANSCRIPTION_DRY_RUN_URL and
 * TRANSCRIPTION_DRY_RUN_MODEL to also hit a live Whisper server
 * (/v1/models liveness + one real transcription of a generated silence clip —
 * requires ffmpeg on PATH).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseSrt,
  serializeSrt,
  serializeVtt,
  srtToVtt,
  cuesToTranscriptTxt,
  formatCueTimestamp,
  reflowCues,
  collapseRepeatedCues,
  mergeOrphanWordCues,
} from '../src/lib/subtitles'
import {
  splitCueAt,
  mergeWithNext,
  clampCueTiming,
  insertCueAt,
  deleteCue,
  toEditorCues,
  parseFlexibleTimestampMs,
  MIN_CUE_DURATION_MS,
  type EditorCue,
} from '../src/lib/subtitle-edit'
import { bucketPeaks, renormalizePeaks, parseWavHeader } from '../src/lib/waveform-peaks'

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------------------
// 1. Basic parse
// ---------------------------------------------------------------------------
const BASIC_SRT = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:05,250
Second cue
with a second line
`

{
  const cues = parseSrt(BASIC_SRT)
  check('basic: two cues parsed', cues.length === 2)
  check('basic: timing parsed', cues[0]?.startMs === 1000 && cues[0]?.endMs === 2500)
  check('basic: multi-line text preserved', cues[1]?.text === 'Second cue\nwith a second line')
}

// ---------------------------------------------------------------------------
// 2. BOM + CRLF + missing index + out-of-order + junk blocks
// ---------------------------------------------------------------------------
const MESSY_SRT =
  '﻿' +
  [
    // no index line
    '00:00:10,000 --> 00:00:12,000',
    'Later cue first',
    '',
    'NOTE this block has no timing and must be skipped',
    '',
    '99',
    '00:00:01,500 --> 00:00:03,000',
    'Early cue second',
    '',
    '',
    '3',
    'broken --> timestamps',
    'skipped too',
  ].join('\r\n')

{
  const cues = parseSrt(MESSY_SRT)
  check('messy: junk blocks skipped', cues.length === 2)
  check('messy: sorted by start time', cues[0]?.text === 'Early cue second')
  check('messy: re-indexed from 1', cues[0]?.index === 1 && cues[1]?.index === 2)
}

// ---------------------------------------------------------------------------
// 3. SRT round-trip stability
// ---------------------------------------------------------------------------
{
  const once = serializeSrt(parseSrt(MESSY_SRT))
  const twice = serializeSrt(parseSrt(once))
  check('round-trip: serializeSrt(parseSrt(x)) is stable', once === twice)
}

// ---------------------------------------------------------------------------
// 4. VTT output
// ---------------------------------------------------------------------------
{
  const vtt = srtToVtt(BASIC_SRT)
  check('vtt: starts with WEBVTT header', vtt.startsWith('WEBVTT\n\n'))
  check('vtt: uses dot ms separator', vtt.includes('00:00:01.000 --> 00:00:02.500'))
  check('vtt: parseable back to same cues', serializeSrt(parseSrt(vtt.replace(/^WEBVTT\n\n/, ''))) === serializeSrt(parseSrt(BASIC_SRT)))
}

// ---------------------------------------------------------------------------
// 5. Transcript export + timestamp formatting
// ---------------------------------------------------------------------------
{
  const txt = cuesToTranscriptTxt(parseSrt(BASIC_SRT))
  check('transcript: joined into plain text', txt === 'Hello world Second cue with a second line\n')
  check('timestamp: formatCueTimestamp', formatCueTimestamp(83450) === '00:01:23.450')
}

// ---------------------------------------------------------------------------
// 6. Overlong hour + end<start rejection
// ---------------------------------------------------------------------------
{
  const cues = parseSrt('1\n125:00:01,000 --> 125:00:02,000\nLong movie\n\n2\n00:00:05,000 --> 00:00:04,000\nBackwards, skipped\n')
  check('edge: >99h timestamps accepted', cues.length === 1 && cues[0].startMs === 125 * 3_600_000 + 1000)
}

// ---------------------------------------------------------------------------
// 6b. Caption formatting (reflowCues)
// ---------------------------------------------------------------------------
{
  const cue = [{ index: 1, startMs: 0, endMs: 4000, text: 'the quick brown fox jumps over the lazy dog again and again' }]
  const wrapped = reflowCues(cue, { maxCharsPerLine: 20, maxLines: 2 })
  const allLinesFit = wrapped.every((c) => c.text.split('\n').every((l) => l.length <= 20))
  check('reflow: every line within maxCharsPerLine', allLinesFit)
  check('reflow: overflow split into multiple cues', wrapped.length > 1)
  check('reflow: split cues stay within original time range', wrapped[0].startMs === 0 && wrapped[wrapped.length - 1].endMs === 4000)
  check('reflow: each cue has at most maxLines lines', wrapped.every((c) => c.text.split('\n').length <= 2))

  const short = reflowCues([{ index: 1, startMs: 0, endMs: 1000, text: 'hello there' }], { maxCharsPerLine: 42, maxLines: 2 })
  check('reflow: short cue stays a single cue', short.length === 1 && short[0].text === 'hello there')

  const disabled = reflowCues(cue, { maxCharsPerLine: 0, maxLines: 2 })
  check('reflow: maxCharsPerLine=0 leaves text untouched', disabled.length === 1 && disabled[0].text === cue[0].text)

  // Orphan guard: a split that would strand one word as the final cue folds it
  // back into the previous cue (that line may exceed maxCharsPerLine).
  const orphan = reflowCues(
    [{ index: 1, startMs: 0, endMs: 3000, text: 'the quick brown fox jumps' }],
    { maxCharsPerLine: 20, maxLines: 1 },
  )
  check('reflow: lone-word remainder folds into previous cue', orphan.length === 1 && orphan[0].text === 'the quick brown fox jumps')
  const twoWords = reflowCues(
    [{ index: 1, startMs: 0, endMs: 3000, text: 'the quick brown fox jumps high' }],
    { maxCharsPerLine: 20, maxLines: 1 },
  )
  check('reflow: two-word remainder keeps its own cue', twoWords.length === 2 && twoWords[1].text === 'jumps high')
  check('reflow: orphan fold also applies with maxLines=2', (() => {
    // Wraps to 5 lines: alpha / bravo / charlie / delta echo / golf →
    // the lone "golf" group folds into the previous group's last line.
    const multi = reflowCues(
      [{ index: 1, startMs: 0, endMs: 5000, text: 'alpha bravo charlie delta echo golf' }],
      { maxCharsPerLine: 10, maxLines: 2 },
    )
    return multi.length === 2 && multi[1].text === 'charlie\ndelta echo golf'
  })())

  // Sentence-boundary refinement: when a group's last line has 1-2 orphaned
  // words trailing a period, move them to the next group so the new sentence
  // starts on its own cue. "First thing here now. And then" → split at the
  // period: cue 0 ends with ".", cue 1 starts with "And then".
  // (The orphan guard may still fold a lone-word final group — that's separate.)
  const sentBoundary = reflowCues(
    [{ index: 1, startMs: 0, endMs: 3000, text: 'First thing here now. And then second thing here now more words.' }],
    { maxCharsPerLine: 30, maxLines: 1 },
  )
  check('reflow: sentence boundary — orphaned word moves to next cue',
    sentBoundary.length === 2 &&
    sentBoundary[0].text === 'First thing here now.' &&
    sentBoundary[1].text.startsWith('And then') &&
    sentBoundary[1].text.includes('second thing'))
}

// ---------------------------------------------------------------------------
// 6b2. Lone-word cue merging (mergeOrphanWordCues)
// ---------------------------------------------------------------------------
{
  // Whisper segmented a trailing word off on its own with a tiny gap → merge.
  const merged = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 2000, text: 'and that wraps up the' },
    { index: 2, startMs: 2100, endMs: 2400, text: 'edit.' },
  ])
  check('orphan merge: small-gap lone word joins previous cue', merged.length === 1 && merged[0].text === 'and that wraps up the edit.' && merged[0].endMs === 2400)

  // A lone word after a real pause is a deliberate utterance → keep it.
  const paused = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 2000, text: 'take a look at this' },
    { index: 2, startMs: 5000, endMs: 5600, text: 'Perfect.' },
  ])
  check('orphan merge: lone word after a large gap keeps its own cue', paused.length === 2)

  // Two-word cues are fine as-is; first cue has no predecessor.
  const untouched = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 500, text: 'Okay.' },
    { index: 2, startMs: 600, endMs: 2000, text: 'sounds good' },
  ])
  check('orphan merge: two-word cue and first cue untouched', untouched.length === 2)

  // Chained lone words all fold into the same predecessor.
  const chain = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 1000, text: 'one two three' },
    { index: 2, startMs: 1100, endMs: 1300, text: 'four' },
    { index: 3, startMs: 1400, endMs: 1600, text: 'five' },
  ])
  check('orphan merge: consecutive lone words chain into one cue', chain.length === 1 && chain[0].text === 'one two three four five' && chain[0].endMs === 1600)

  // Gap threshold (default 500 ms): a lone word ≤ 500 ms after the previous
  // cue is merged; > 500 ms keeps its own cue so the natural pause is visible.
  const tightGap = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 2000, text: 'and that is the' },
    { index: 2, startMs: 2400, endMs: 2800, text: 'end.' }, // 400 ms gap → merge
  ])
  check('orphan merge: 400 ms gap merges lone word', tightGap.length === 1 && tightGap[0].text === 'and that is the end.')

  const wideGap = mergeOrphanWordCues([
    { index: 1, startMs: 0, endMs: 2000, text: 'take a look at this' },
    { index: 2, startMs: 2600, endMs: 3000, text: 'Wow.' }, // 600 ms gap → keep
  ])
  check('orphan merge: 600 ms gap keeps lone word as its own cue', wideGap.length === 2 && wideGap[1].text === 'Wow.')
}

// ---------------------------------------------------------------------------
// 6c. Hallucination collapse (collapseRepeatedCues)
// ---------------------------------------------------------------------------
{
  // The end-of-video "Thank you." flurry from the report.
  const flurry = [
    { index: 1, startMs: 33110, endMs: 33310, text: 'Thank you, guys.' },
    { index: 2, startMs: 33310, endMs: 33410, text: 'Thank you, guys.' },
    { index: 3, startMs: 33410, endMs: 33610, text: 'Thank you.' },
    { index: 4, startMs: 33610, endMs: 33650, text: 'Thank you.' },
    { index: 5, startMs: 33650, endMs: 33670, text: 'Thank you.' },
    { index: 6, startMs: 33670, endMs: 33730, text: 'Thank you.' },
  ]
  const collapsed = collapseRepeatedCues(flurry)
  check('collapse: flurry reduced to 2 cues', collapsed.length === 2)
  check('collapse: merged cue spans full run', collapsed[1].startMs === 33410 && collapsed[1].endMs === 33730)
  check('collapse: re-indexed from 1', collapsed[0].index === 1 && collapsed[1].index === 2)
  check('collapse: punctuation/case-insensitive equality', collapseRepeatedCues([
    { index: 1, startMs: 0, endMs: 500, text: 'Thank you' },
    { index: 2, startMs: 500, endMs: 900, text: 'thank you.' },
  ]).length === 1)

  // Genuine repeat with a real pause must be preserved.
  const spaced = collapseRepeatedCues([
    { index: 1, startMs: 0, endMs: 1000, text: 'No.' },
    { index: 2, startMs: 5000, endMs: 6000, text: 'No.' },
  ])
  check('collapse: same text far apart is NOT merged', spaced.length === 2)

  // Distinct adjacent lines are left alone.
  const distinct = collapseRepeatedCues([
    { index: 1, startMs: 0, endMs: 1000, text: 'Hello.' },
    { index: 2, startMs: 1000, endMs: 2000, text: 'Goodbye.' },
  ])
  check('collapse: distinct adjacent cues untouched', distinct.length === 2)
}

// ---------------------------------------------------------------------------
// 6c. Editor cue operations (subtitle-edit.ts)
// ---------------------------------------------------------------------------
{
  const mk = (startMs: number, endMs: number, text: string): EditorCue => ({ id: `${startMs}-${endMs}`, startMs, endMs, text })
  const base = [mk(0, 2000, 'alpha bravo charlie delta'), mk(3000, 5000, 'echo'), mk(6000, 8000, 'foxtrot golf')]

  // splitCueAt
  const split = splitCueAt(base, base[0].id, 1000)
  check('split: yields two cues', split !== null && split.length === 4)
  check('split: halves meet at split point', !!split && split[0].endMs === 1000 && split[1].startMs === 1000)
  check('split: word-boundary text split', !!split && split[0].text === 'alpha bravo' && split[1].text === 'charlie delta')
  check('split: clamped near edge keeps min duration', (() => {
    const s = splitCueAt(base, base[0].id, 50) // clamps to startMs + MIN
    return !!s && s[0].endMs - s[0].startMs >= MIN_CUE_DURATION_MS && s[1].endMs - s[1].startMs >= MIN_CUE_DURATION_MS
  })())
  check('split: refuses too-short cue', splitCueAt([mk(0, 300, 'x')], '0-300', 150) === null)

  // mergeWithNext
  const merged = mergeWithNext(base, base[0].id)
  check('merge: spans both + joins text', !!merged && merged.length === 2 && merged[0].startMs === 0 && merged[0].endMs === 5000 && merged[0].text === 'alpha bravo charlie delta echo')
  check('merge: last cue returns null', mergeWithNext(base, base[2].id) === null)
  check('merge: over-length refusal', mergeWithNext([mk(0, 1000, 'a'.repeat(900)), mk(1000, 2000, 'b'.repeat(200))], '0-1000') === null)

  // clampCueTiming
  const moved = clampCueTiming(base, base[1].id, { startMs: 100, endMs: 2100 }, 'move', 10000)
  check('clamp move: blocked by prev neighbour', moved.startMs === 2000 && moved.endMs === 4000)
  const movedR = clampCueTiming(base, base[1].id, { startMs: 5500, endMs: 7500 }, 'move', 10000)
  check('clamp move: blocked by next neighbour', movedR.endMs === 6000 && movedR.startMs === 4000)
  const shrunk = clampCueTiming(base, base[1].id, { startMs: 3000, endMs: 3050 }, 'resize-end', 10000)
  check('clamp resize: enforces min duration', shrunk.endMs - shrunk.startMs >= MIN_CUE_DURATION_MS)
  const bounded = clampCueTiming(base, base[2].id, { startMs: 6000, endMs: 99999 }, 'resize-end', 8000)
  check('clamp resize: bounded by video duration', bounded.endMs === 8000)
  const overlapping = [mk(0, 3000, 'a'), mk(2000, 4000, 'b'), mk(3500, 6000, 'c')]
  const defensive = clampCueTiming(overlapping, overlapping[1].id, { startMs: 2500, endMs: 4500 }, 'move', 10000)
  check('clamp: defensive on pre-existing overlaps (start < end)', defensive.startMs < defensive.endMs)

  // insertCueAt
  const ins = insertCueAt(base, 5200, 10000)
  check('insert: lands in the gap', !!ins && ins.cues.length === 4 && ins.cues.find(c => c.id === ins.newId)!.startMs >= 5000 && ins.cues.find(c => c.id === ins.newId)!.endMs <= 6000)
  check('insert: no adequate gap returns null', insertCueAt([mk(0, 5000, 'a'), mk(5100, 10000, 'b')], 5050, 10000) === null)

  // deleteCue + toEditorCues ids
  check('delete: removes by id', deleteCue(base, base[1].id).length === 2)
  const ed = toEditorCues([{ index: 1, startMs: 0, endMs: 1000, text: 'x' }, { index: 2, startMs: 1000, endMs: 2000, text: 'y' }])
  check('toEditorCues: unique stable ids', ed[0].id !== ed[1].id && ed.every(c => typeof c.id === 'string' && c.id.length > 0))

  // parseFlexibleTimestampMs
  check('parse: mm:ss.mmm', parseFlexibleTimestampMs('01:23.450') === 83450)
  check('parse: hh:mm:ss', parseFlexibleTimestampMs('1:02:03') === 3723000)
  check('parse: bare seconds', parseFlexibleTimestampMs('12.5') === 12500)
  check('parse: comma separator', parseFlexibleTimestampMs('01:23,450') === 83450)
  check('parse: garbage returns null', parseFlexibleTimestampMs('abc') === null && parseFlexibleTimestampMs('1:2:3:4') === null)
}

// ---------------------------------------------------------------------------
// 6d. Waveform peaks (waveform-peaks.ts)
// ---------------------------------------------------------------------------
{
  // bucketPeaks: 2 seconds of alternating loud/quiet at 8 samples/sec buckets
  const rate = 800
  const samples = new Int16Array(rate * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = i < rate ? 32768 / 2 : 3277 // first second ~0.5, second ~0.1
  }
  const peaks = bucketPeaks(samples, rate, 8)
  check('peaks: bucket count = durationSec * pps', peaks.length === 16)
  check('peaks: loud second ≈ 0.5', Math.abs(peaks[0] - 0.5) < 0.02)
  check('peaks: quiet second ≈ 0.1', Math.abs(peaks[15] - 0.1) < 0.02)

  const renorm = renormalizePeaks([0.1, 0.2, 0.4])
  check('peaks: quiet track renormalized to 1.0 max', Math.max(...renorm) === 1)
  const loud = renormalizePeaks([0.5, 0.95])
  check('peaks: loud track left alone', loud[1] === 0.95)

  // Hand-built WAV with a LIST chunk before data (ffmpeg-style, not 44-byte)
  const dataSamples = new Int16Array([1000, -2000, 3000, -32768])
  const dataBytes = Buffer.from(dataSamples.buffer)
  const listBody = Buffer.from('INFOISFT\x0a\x00\x00\x00dry-run\x00\x00\x00', 'binary')
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)        // PCM
  fmt.writeUInt16LE(1, 10)       // mono
  fmt.writeUInt32LE(16000, 12)   // sample rate
  fmt.writeUInt32LE(32000, 16)   // byte rate
  fmt.writeUInt16LE(2, 20)       // block align
  fmt.writeUInt16LE(16, 22)      // bits
  const list = Buffer.alloc(8 + listBody.length)
  list.write('LIST', 0, 'ascii'); list.writeUInt32LE(listBody.length, 4); listBody.copy(list, 8)
  const dataHdr = Buffer.alloc(8)
  dataHdr.write('data', 0, 'ascii'); dataHdr.writeUInt32LE(dataBytes.length, 4)
  const riffBody = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, list, dataHdr, dataBytes])
  const wav = Buffer.alloc(8 + riffBody.length)
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(riffBody.length, 4); riffBody.copy(wav, 8)

  try {
    const parsed = parseWavHeader(wav)
    check('wav: header walk skips LIST chunk', parsed.format.sampleRate === 16000 && parsed.format.numChannels === 1 && parsed.dataLength === dataBytes.length)
    check('wav: data offset points at samples', wav.readInt16LE(parsed.dataOffset) === 1000)
  } catch (e) {
    check('wav: header walk skips LIST chunk', false, e instanceof Error ? e.message : String(e))
  }
  let rejected = false
  try { parseWavHeader(Buffer.from('not a wav file at all........', 'ascii')) } catch { rejected = true }
  check('wav: rejects non-RIFF input', rejected)
}

// ---------------------------------------------------------------------------
// 7. Optional: live Whisper server
// ---------------------------------------------------------------------------
async function liveWhisperCheck() {
  const url = process.env.TRANSCRIPTION_DRY_RUN_URL
  const model = process.env.TRANSCRIPTION_DRY_RUN_MODEL
  if (!url || !model) {
    console.log('SKIP  live Whisper check (set TRANSCRIPTION_DRY_RUN_URL + TRANSCRIPTION_DRY_RUN_MODEL to enable)')
    return
  }
  const base = url.replace(/\/+$/, '')

  const modelsRes = await fetch(`${base}/v1/models`)
  const models = (await modelsRes.json()) as { data?: Array<{ id: string }> }
  check('live: /v1/models reachable', modelsRes.ok, `status ${modelsRes.status}`)
  const ids = (models.data ?? []).map((m) => m.id)
  check('live: configured model listed', ids.includes(model), ids.slice(0, 5).join(', ') || 'no models returned')

  // 2s of silence via ffmpeg → one real transcription call
  const dir = mkdtempSync(path.join(tmpdir(), 'transcription-dry-run-'))
  const wavPath = path.join(dir, 'silence.wav')
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:a', 'pcm_s16le', wavPath], { stdio: 'ignore' })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    })
    const form = new FormData()
    form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'silence.wav')
    form.append('model', model)
    form.append('response_format', 'srt')
    const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
    const body = await res.text()
    check('live: transcription call succeeded', res.ok, res.ok ? undefined : `status ${res.status}: ${body.slice(0, 200)}`)
    if (res.ok) {
      // Silence may legitimately produce zero cues — only assert it parses
      const cues = parseSrt(body)
      check('live: SRT response parseable', Array.isArray(cues), `${cues.length} cue(s)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

liveWhisperCheck()
  .catch((e) => check('live: whisper check crashed', false, e instanceof Error ? e.message : String(e)))
  .finally(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
