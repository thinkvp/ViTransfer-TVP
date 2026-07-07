/**
 * Waveform peaks computation for the subtitle timeline strip.
 *
 * The worker computes peaks from the SAME 16 kHz mono s16le WAV the
 * transcription job already extracts, so this costs no extra ffmpeg pass.
 * The pure bucketing core (bucketPeaks) is dry-run-testable; the file reader
 * STREAMS the WAV — a 1-hour extraction is ~115 MB and must never be
 * buffered whole in the worker.
 */
import fs from 'fs'
import type { WaveformPeaks } from './subtitle-edit'

// Higher density = a smoother, more detailed waveform in the editor strip.
// 40 pps × 2 bytes/number-ish → ~14 KB JSON for a 90 s clip; long videos reduce
// pps to stay under MAX_PEAK_BUCKETS.
export const DEFAULT_PEAKS_PER_SECOND = 40
/** 15 min at 40 pps; longer videos reduce pps instead of growing the JSON. */
export const MAX_PEAK_BUCKETS = 36_000

/** Pure core: max-abs per (sampleRate / peaksPerSecond) window, normalized 0..1. */
export function bucketPeaks(samples: Int16Array, sampleRate: number, peaksPerSecond: number): number[] {
  const perBucket = Math.max(1, Math.round(sampleRate / peaksPerSecond))
  const out: number[] = []
  for (let i = 0; i < samples.length; i += perBucket) {
    let max = 0
    const end = Math.min(samples.length, i + perBucket)
    for (let j = i; j < end; j++) {
      const a = Math.abs(samples[j])
      if (a > max) max = a
    }
    out.push(Math.round((max / 32768) * 100) / 100)
  }
  return out
}

/** Renormalize quiet audio so low-level dialogue still shows shape. */
export function renormalizePeaks(peaks: number[]): number[] {
  let globalMax = 0
  for (const p of peaks) if (p > globalMax) globalMax = p
  if (globalMax <= 0 || globalMax >= 0.9) return peaks
  return peaks.map((p) => Math.round((p / globalMax) * 100) / 100)
}

interface WavFormat {
  sampleRate: number
  numChannels: number
  bitsPerSample: number
  audioFormat: number
}

/**
 * Parse the RIFF header + chunk list from an initial buffer. Does NOT assume
 * a fixed 44-byte header — ffmpeg can emit LIST/INFO chunks before `data`.
 * Returns the format and the byte offset + length of the data chunk.
 * The initial buffer must be large enough to contain everything up to the
 * start of the data chunk (a few hundred bytes in practice; we read 64 KB).
 */
export function parseWavHeader(buf: Buffer): { format: WavFormat; dataOffset: number; dataLength: number } {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  let format: WavFormat | null = null
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      if (body + 16 > buf.length) throw new Error('Truncated fmt chunk')
      format = {
        audioFormat: buf.readUInt16LE(body),
        numChannels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data') {
      if (!format) throw new Error('WAV data chunk before fmt chunk')
      if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV format (audioFormat=${format.audioFormat}, bits=${format.bitsPerSample}) — expected 16-bit PCM`)
      }
      return { format, dataOffset: body, dataLength: chunkSize }
    }
    // Chunks are word-aligned: odd sizes are padded with one byte
    offset = body + chunkSize + (chunkSize % 2)
  }
  throw new Error('WAV data chunk not found in header window')
}

/**
 * Stream a 16-bit PCM mono WAV file and compute normalized peaks. Handles
 * multi-channel input defensively by folding all channels through the same
 * max-abs (channel interleaving doesn't change the max envelope).
 */
export async function computeWaveformPeaksFromWav(wavPath: string): Promise<WaveformPeaks> {
  // Read a generous header window first to locate the data chunk
  const headerFd = await fs.promises.open(wavPath, 'r')
  let headerInfo
  try {
    const headerBuf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await headerFd.read(headerBuf, 0, headerBuf.length, 0)
    headerInfo = parseWavHeader(headerBuf.subarray(0, bytesRead))
  } finally {
    await headerFd.close()
  }
  const { format, dataOffset, dataLength } = headerInfo

  const stat = await fs.promises.stat(wavPath)
  // ffmpeg sometimes writes a placeholder data size; trust the file length
  const effectiveDataLength = Math.min(dataLength > 0 ? dataLength : Number.MAX_SAFE_INTEGER, stat.size - dataOffset)

  const totalSamples = Math.floor(effectiveDataLength / 2)
  const samplesPerFrame = Math.max(1, format.numChannels)
  const frameCount = Math.floor(totalSamples / samplesPerFrame)
  const durationSec = frameCount / format.sampleRate

  let peaksPerSecond = DEFAULT_PEAKS_PER_SECOND
  if (durationSec * peaksPerSecond > MAX_PEAK_BUCKETS) {
    peaksPerSecond = Math.max(1, Math.floor(MAX_PEAK_BUCKETS / durationSec))
  }
  // Bucket by FRAMES so multi-channel audio keeps correct time alignment
  const framesPerBucket = Math.max(1, Math.round(format.sampleRate / peaksPerSecond))

  const peaks: number[] = []
  let bucketMax = 0
  let framesInBucket = 0
  let sampleInFrame = 0
  let carry: Buffer | null = null

  const stream = fs.createReadStream(wavPath, {
    start: dataOffset,
    end: dataOffset + effectiveDataLength - 1,
    highWaterMark: 1024 * 1024,
  })

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf: Buffer = carry ? Buffer.concat([carry, chunkBuf]) : chunkBuf
    const usable: number = buf.length - (buf.length % 2)
    carry = usable < buf.length ? buf.subarray(usable) : null
    for (let i = 0; i < usable; i += 2) {
      const a = Math.abs(buf.readInt16LE(i))
      if (a > bucketMax) bucketMax = a
      sampleInFrame += 1
      if (sampleInFrame >= samplesPerFrame) {
        sampleInFrame = 0
        framesInBucket += 1
        if (framesInBucket >= framesPerBucket) {
          peaks.push(Math.round((bucketMax / 32768) * 100) / 100)
          bucketMax = 0
          framesInBucket = 0
        }
      }
    }
  }
  if (framesInBucket > 0) {
    peaks.push(Math.round((bucketMax / 32768) * 100) / 100)
  }

  return {
    version: 1,
    peaksPerSecond,
    durationMs: Math.round(durationSec * 1000),
    peaks: renormalizePeaks(peaks),
  }
}
