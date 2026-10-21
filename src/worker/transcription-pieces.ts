/**
 * Cutting and transcribing the pieces a video's audio is sent to Whisper in.
 * Kept apart from transcription-processor.ts (which owns the DB writes) so the
 * piece logic can be exercised against a Whisper server on its own.
 */
import path from 'path'
import fs from 'fs'
import { whisperTranscribeVerbose, type WhisperConfig, type WhisperVerboseJsonResponse } from '../lib/whisper'
import { extractAudioForTranscription, detectSilences } from '../lib/ffmpeg'
import {
  CHUNK_THRESHOLD_SEC,
  MIN_SPLIT_SEC,
  UNPUNCTUATED_RUN_LIMIT,
  UNHEARD_STRETCH_LIMIT_SEC,
  planTranscriptionChunks,
  splitTranscriptionChunk,
  longestUnpunctuatedRun,
  longestUnheardStretch,
  transcriptScore,
  type SilenceSpan,
  type TranscriptionChunk,
} from '../lib/transcription-chunks'
import { TRANSCRIPTION_AUDIO_MP3_KBPS, OPENAI_AUDIO_UPLOAD_CAP_BYTES, OPENAI_AAC_KBPS } from '../lib/transcription-audio'

export const VIDEO_TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000 // long videos on a CPU-bound NAS

export interface TranscriptionPiece {
  chunk: TranscriptionChunk
  path: string
  fileName: string
  mimeType: string
}

/** Where pieces are cut from; silences are found lazily, on the first split. */
export interface PieceSource {
  audioMp3Path: string
  tempDir: string
  provider: 'LOCAL' | 'OPENAI'
  silences: SilenceSpan[] | null
  nextId: number
}

/** A split piece is retried at most this many levels down (a piece → 4 quarters). */
const MAX_SPLIT_DEPTH = 2

/** "1:02:05" / "4:07" — log-friendly position in the audio. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * Cut the cached transcription mp3 into the pieces Whisper is sent. Audio over
 * CHUNK_THRESHOLD_SEC is split at silences into ~10-minute pieces (see
 * transcription-chunks.ts for why); shorter audio stays one piece.
 *
 * Local Whisper gets mp3 (no size limit — a single piece is the cached file
 * itself). OpenAI gets a compact AAC-LC copy (mono 16 kHz 48 kbps): its 25 MB
 * upload cap applies per request, and a 10-minute piece is ~3.5 MB, so video
 * length is no longer limited for OpenAI.
 */
export async function prepareTranscriptionPieces(
  source: PieceSource,
  videoDurationSec: number,
): Promise<TranscriptionPiece[]> {
  let chunks: TranscriptionChunk[]
  if (videoDurationSec > 0 && videoDurationSec <= CHUNK_THRESHOLD_SEC) {
    chunks = [{ startSec: 0, endSec: videoDurationSec }]
  } else {
    // Long, or length unknown: measure the audio itself and find the silences.
    const { silences, durationSec } = await detectSilences(source.audioMp3Path)
    source.silences = silences
    const total = durationSec ?? videoDurationSec
    chunks = total > 0 ? planTranscriptionChunks(total, silences) : []
    if (chunks.length === 0) chunks = [{ startSec: 0, endSec: Number.MAX_SAFE_INTEGER }]
  }
  const whole = chunks.length === 1
  const pieces: TranscriptionPiece[] = []
  for (const chunk of chunks) pieces.push(await extractPiece(source, chunk, whole))
  return pieces
}

/** Write one piece's audio to the temp dir in the format its provider takes. */
async function extractPiece(source: PieceSource, chunk: TranscriptionChunk, whole = false): Promise<TranscriptionPiece> {
  const range = whole ? undefined : chunk
  const n = String(++source.nextId).padStart(2, '0')
  if (source.provider === 'OPENAI') {
    const piecePath = path.join(source.tempDir, `piece-${n}.m4a`)
    await extractAudioForTranscription(source.audioMp3Path, piecePath, 'aac', OPENAI_AAC_KBPS, range)
    const bytes = (await fs.promises.stat(piecePath)).size
    if (bytes > OPENAI_AUDIO_UPLOAD_CAP_BYTES) {
      throw new Error(`Transcription piece at ${formatClock(chunk.startSec)} is ${(bytes / 1048576).toFixed(1)} MB, over OpenAI's 25 MB upload cap.`)
    }
    return { chunk, path: piecePath, fileName: 'audio.m4a', mimeType: 'audio/mp4' }
  }
  if (whole) return { chunk, path: source.audioMp3Path, fileName: 'audio.mp3', mimeType: 'audio/mpeg' }
  const piecePath = path.join(source.tempDir, `piece-${n}.mp3`)
  await extractAudioForTranscription(source.audioMp3Path, piecePath, 'mp3', TRANSCRIPTION_AUDIO_MP3_KBPS, range)
  return { chunk, path: piecePath, fileName: 'audio.mp3', mimeType: 'audio/mpeg' }
}

/**
 * Transcribe one piece, and retry it in two fresh halves (down to
 * MAX_SPLIT_DEPTH) when it shows a derailed decode:
 *  - it lost its punctuation — often a piece that opens on a song, whose
 *    lowercase unpunctuated lyrics Whisper then keeps copying; or
 *  - a long stretch has sound but no words — speech Whisper skipped (seen
 *    straight after a long music bed), or just music.
 * The split result is kept only when its `transcriptScore` beats the
 * original's, so music or sung lyrics cost a few extra requests and change
 * nothing.
 */
export async function transcribePieceVerbose(
  source: PieceSource,
  config: WhisperConfig,
  piece: TranscriptionPiece,
  opts: { allowEmpty: boolean; depth: number; videoId: string },
): Promise<{ chunk: TranscriptionChunk; response: WhisperVerboseJsonResponse }[]> {
  const response = await whisperTranscribeVerbose({
    config,
    audio: piece.path,
    fileName: piece.fileName,
    mimeType: piece.mimeType,
    timeoutMs: VIDEO_TRANSCRIBE_TIMEOUT_MS,
    allowEmpty: opts.allowEmpty,
  })
  const kept = [{ chunk: piece.chunk, response }]
  const len = piece.chunk.endSec - piece.chunk.startSec
  const lengthUnknown = piece.chunk.endSec === Number.MAX_SAFE_INTEGER
  if (opts.depth >= MAX_SPLIT_DEPTH || len < MIN_SPLIT_SEC || lengthUnknown) return kept

  if (!source.silences) source.silences = (await detectSilences(source.audioMp3Path)).silences
  const text = response.text ?? ''
  const run = longestUnpunctuatedRun(text)
  const segmentWords = (response.segments ?? []).flatMap((s) => s.words ?? [])
  const unheard = longestUnheardStretch(piece.chunk, segmentWords.length > 0 ? segmentWords : (response.words ?? []), source.silences)
  if (run <= UNPUNCTUATED_RUN_LIMIT && unheard <= UNHEARD_STRETCH_LIMIT_SEC) return kept

  const where = `${formatClock(piece.chunk.startSec)}–${formatClock(piece.chunk.endSec)}`
  const why = run > UNPUNCTUATED_RUN_LIMIT ? `${run} words unpunctuated` : `${Math.round(unheard)}s of sound with no words`
  console.log(`[transcription] Video ${opts.videoId}: ${where} came back with ${why} — retrying in two halves`)
  const parts: { chunk: TranscriptionChunk; response: WhisperVerboseJsonResponse }[] = []
  for (const half of splitTranscriptionChunk(piece.chunk, source.silences)) {
    const halfPiece = await extractPiece(source, half)
    parts.push(...(await transcribePieceVerbose(source, config, halfPiece, { ...opts, allowEmpty: true, depth: opts.depth + 1 })))
  }
  const splitScore = parts.reduce((sum, p) => sum + transcriptScore(p.response.text ?? ''), 0)
  const originalScore = transcriptScore(text)
  if (splitScore <= originalScore) return kept
  console.log(`[transcription] Video ${opts.videoId}: ${where} retry kept (score ${originalScore} → ${splitScore})`)
  return parts
}
