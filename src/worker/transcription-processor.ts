import { Job } from 'bullmq'
import path from 'path'
import fs from 'fs'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/db'
import type { TranscriptionJob } from '../lib/queue'
import { whisperTranscribe, whisperTestConnection, type WhisperConfig } from '../lib/whisper'
import { parseSrt, serializeSrt, serializeVtt, reflowCues, collapseRepeatedCues } from '../lib/subtitles'
import { extractAudioForTranscription } from '../lib/ffmpeg'
import { computeWaveformPeaksFromWav } from '../lib/waveform-peaks'
import { decrypt } from '../lib/encryption'
import { getStoredFilePath, registerStoredFiles } from '../lib/stored-file'
import { uploadFileFromPath } from '../lib/storage'
import { materializeStoragePathToLocalFile } from '../lib/storage-provider'
import { buildVideoSubtitlesStorageRoot } from '../lib/project-storage-paths'
import { storeTranscriptionAudio, TRANSCRIPTION_AUDIO_MP3_KBPS, OPENAI_AUDIO_UPLOAD_CAP_BYTES, OPENAI_AAC_KBPS, OPENAI_MAX_DURATION_SEC } from '../lib/transcription-audio'
import {
  recalculateAndStoreProjectTotalBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectDiskBytes,
} from '../lib/project-total-bytes'
import type { AiRequestAttachment } from '../lib/ai/attachments'
import { TEMP_DIR } from './cleanup'

const DEBUG = process.env.DEBUG_WORKER === 'true'

const MAX_ERROR_LENGTH = 2000
const VIDEO_TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000 // long videos on a CPU-bound NAS
const DICTATION_TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 1000

class WhisperNotConfiguredError extends Error {
  constructor(message = 'Whisper transcription is not enabled or the server URL is not configured.') {
    super(message)
    this.name = 'WhisperNotConfiguredError'
  }
}

interface ResolvedWhisperConfig extends WhisperConfig {
  enabled: boolean
  provider: 'LOCAL' | 'OPENAI'
  /** Send compressed (mp3) audio instead of WAV — required for OpenAI's 25 MB upload cap. */
  compressed: boolean
  maxCharsPerLine: number
  maxLines: number
}

async function getWhisperConfig(): Promise<ResolvedWhisperConfig> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      transcriptionEnabled: true,
      transcriptionProvider: true,
      transcriptionWhisperUrl: true,
      transcriptionWhisperModel: true,
      transcriptionOpenaiApiKey: true,
      transcriptionOpenaiModel: true,
      transcriptionLanguage: true,
      transcriptionMaxCharsPerLine: true,
      transcriptionMaxLines: true,
    },
  })
  const enabledFlag = settings?.transcriptionEnabled === true
  const language = settings?.transcriptionLanguage
  const maxCharsPerLine = settings?.transcriptionMaxCharsPerLine ?? 0
  const maxLines = settings?.transcriptionMaxLines ?? 2

  if ((settings?.transcriptionProvider ?? 'LOCAL') === 'OPENAI') {
    const apiKey = settings?.transcriptionOpenaiApiKey ? decrypt(settings.transcriptionOpenaiApiKey) : ''
    return {
      enabled: enabledFlag && !!apiKey,
      provider: 'OPENAI',
      url: 'https://api.openai.com',
      model: settings?.transcriptionOpenaiModel || 'whisper-1',
      apiKey,
      language,
      compressed: true,
      maxCharsPerLine,
      maxLines,
    }
  }

  return {
    enabled: enabledFlag && !!settings?.transcriptionWhisperUrl,
    provider: 'LOCAL',
    url: settings?.transcriptionWhisperUrl ?? '',
    model: settings?.transcriptionWhisperModel || 'deepdml/faster-whisper-large-v3-turbo-ct2',
    apiKey: null,
    language,
    compressed: false,
    maxCharsPerLine,
    maxLines,
  }
}

export async function processTranscription(job: Job<TranscriptionJob>) {
  const data = job.data
  switch (data.kind) {
    case 'video-subtitles':
      return processVideoSubtitles(data.videoId, data.force === true)
    case 'dictation':
      return processDictation(data.requestId)
    case 'whisper-test':
      return processWhisperTest(data.requestId)
    default: {
      const exhaustive: never = data
      console.warn('[transcription] Unknown job kind — skipping', exhaustive)
    }
  }
}

// ---------------------------------------------------------------------------
// Video subtitles (SRT VideoAsset + playback VTT)
// ---------------------------------------------------------------------------

/** Keep the download filename filesystem/browser-friendly without losing meaning. */
function sanitizeSubtitleFileName(name: string, versionLabel: string): string {
  const base = `${name}_${versionLabel}_captions`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return `${base}.srt`
}

async function processVideoSubtitles(videoId: string, force: boolean) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      name: true,
      versionLabel: true,
      status: true,
      duration: true,
      transcriptionStatus: true,
      autoGenerateSubtitles: true,
    },
  })
  if (!video) {
    console.warn(`[transcription] Video ${videoId} not found — skipping`)
    return
  }
  if (video.status !== 'READY') {
    console.warn(`[transcription] Video ${videoId} is ${video.status}, not READY — skipping`)
    return
  }
  // Don't double-process a redelivered job another worker is already running
  // (a forced manual regeneration overrides this).
  if (video.transcriptionStatus === 'PROCESSING' && !force) {
    if (DEBUG) console.log(`[transcription] Video ${videoId} already processing — skipping`)
    return
  }

  const config = await getWhisperConfig()
  if (!config.enabled) {
    // Feature was disabled between enqueue and processing — reset to "off"
    await prisma.video.update({
      where: { id: videoId },
      data: { transcriptionStatus: null, transcriptionError: null },
    }).catch(() => {})
    return
  }

  // OpenAI caps uploads at 25 MB, which limits us to ~60 min of audio. Skip
  // longer videos before doing any work (local Whisper has no such cap and is
  // not gated). Existing subtitle files are left in place — only the status
  // note changes, so the admin knows why auto-captions didn't run.
  if (config.provider === 'OPENAI' && video.duration > OPENAI_MAX_DURATION_SEC) {
    const mins = Math.round(video.duration / 60)
    console.log(`[transcription] Video ${videoId}: ${mins} min exceeds the OpenAI 60-minute limit — skipping`)
    // Don't clobber a video that already has captions (e.g. generated on a local
    // server before the provider was switched to OpenAI) — leave those in place.
    if (video.transcriptionStatus !== 'READY') {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          transcriptionStatus: 'SKIPPED',
          transcriptionError: `Auto-captions unavailable — this video is ${mins} minutes, over the 60-minute limit for the OpenAI provider (25 MB upload cap). Use a local Whisper server to caption longer videos.`,
        },
      }).catch(() => {})
    }
    return
  }

  // Decide what work is actually needed:
  //  - Subtitles are only (re)generated when forced or when none exist yet — a
  //    plain reprocess must NEVER overwrite hand-edited cues.
  //  - Per-version opt-out (autoGenerateSubtitles === false) skips the Whisper
  //    run just like "already READY" does — the waveform still generates so the
  //    editor works for manually-set captions. A forced Regenerate overrides.
  //  - The waveform is (re)generated whenever it's missing (or forced), so a
  //    reprocess of an already-transcribed video still heals a missing waveform.
  const subtitlesUpToDate =
    (video.transcriptionStatus === 'READY' || video.autoGenerateSubtitles === false) && !force
  const peaksExist = !!(await getStoredFilePath('VIDEO', videoId, 'WAVEFORM_PEAKS'))
  const needPeaks = force || !peaksExist
  if (subtitlesUpToDate && !needPeaks) {
    if (DEBUG) console.log(`[transcription] Video ${videoId}: subtitles + waveform up to date — skipping`)
    return
  }

  if (!subtitlesUpToDate) {
    await prisma.video.update({
      where: { id: videoId },
      data: { transcriptionStatus: 'PROCESSING', transcriptionError: null },
    })
  }

  const tempDir = path.join(TEMP_DIR, `${videoId}-subtitles`)
  let materializedTemporary = false
  try {
    await fs.promises.mkdir(tempDir, { recursive: true })

    // Prefer the cached transcription audio (small mp3) so a (re)generation never
    // re-downloads the full original from storage. Fall back to the original when
    // the cache is absent (feature enabled after upload, or a pre-cache video),
    // extracting + caching the mp3 for next time. Both Whisper providers accept
    // mp3 directly; waveform peaks decode it to WAV locally when needed.
    let audioMp3Path: string
    const cachedAudioPath = await getStoredFilePath('VIDEO', videoId, 'TRANSCRIPTION_AUDIO')
    if (cachedAudioPath) {
      const materialized = await materializeStoragePathToLocalFile({
        rawPath: cachedAudioPath,
        tempDir,
        suggestedName: 'audio.mp3',
      })
      materializedTemporary = materialized.isTemporary
      audioMp3Path = materialized.localPath
      if (DEBUG) console.log(`[transcription] Video ${videoId}: using cached transcription audio`)
    } else {
      const originalPath = await getStoredFilePath('VIDEO', videoId, 'ORIGINAL')
      if (!originalPath) {
        throw new Error('Original video file is not registered in StoredFile')
      }
      const materialized = await materializeStoragePathToLocalFile({
        rawPath: originalPath,
        tempDir,
        suggestedName: `original${path.posix.extname(originalPath) || '.mp4'}`,
      })
      materializedTemporary = materialized.isTemporary
      audioMp3Path = path.join(tempDir, 'audio.mp3')
      console.log(`[transcription] Extracting + caching transcription audio for video ${videoId}`)
      await extractAudioForTranscription(materialized.localPath, audioMp3Path, 'mp3', TRANSCRIPTION_AUDIO_MP3_KBPS)
      await storeTranscriptionAudio({ videoId, projectId: video.projectId, mp3LocalPath: audioMp3Path }).catch((e) =>
        console.warn(`[transcription] Video ${videoId}: caching transcription audio failed (non-fatal):`, e instanceof Error ? e.message : e),
      )
    }

    const storageRoot = buildVideoSubtitlesStorageRoot(video.projectId, videoId)

    // Waveform peaks for the subtitle timeline strip — (re)generated whenever
    // missing (or forced), including on a reprocess of an already-transcribed
    // video. Isolated so a peaks failure can never fail transcription.
    if (needPeaks) {
      try {
        // Decode the (small) cached mp3 to PCM WAV locally — no network needed.
        const wavPath = path.join(tempDir, 'audio.wav')
        await extractAudioForTranscription(audioMp3Path, wavPath, 'wav')
        const peaks = await computeWaveformPeaksFromWav(wavPath)
        const peaksJson = JSON.stringify(peaks)
        const peaksSize = Buffer.byteLength(peaksJson, 'utf-8')
        const tempPeaksPath = path.join(tempDir, 'waveform.json')
        await fs.promises.writeFile(tempPeaksPath, peaksJson, 'utf-8')
        const peaksStoragePath = `${storageRoot}/waveform.json`
        await uploadFileFromPath(peaksStoragePath, tempPeaksPath, peaksSize, 'application/json')
        await registerStoredFiles([
          {
            entityType: 'VIDEO',
            entityId: videoId,
            fileRole: 'WAVEFORM_PEAKS',
            storagePath: peaksStoragePath,
            fileName: 'waveform.json',
            fileSize: peaksSize,
            status: 'READY',
          },
        ])
        console.log(`[transcription] Video ${videoId}: waveform peaks registered (${peaks.peaks.length} buckets @ ${peaks.peaksPerSecond}pps)`)
        // Reflect the healed waveform in project byte totals
        await Promise.all([
          recalculateAndStoreProjectTotalBytes(video.projectId),
          recalculateAndStoreProjectPreviewBytes(video.projectId),
        ]).catch(() => {})
      } catch (peaksError) {
        console.warn(`[transcription] Video ${videoId}: waveform peaks generation failed (non-fatal):`, peaksError instanceof Error ? peaksError.message : peaksError)
      }
    }

    // Reprocess of an already-transcribed video: the waveform is healed above,
    // and the existing (possibly hand-edited) subtitles are left untouched.
    if (subtitlesUpToDate) {
      console.log(`[transcription] Video ${videoId}: waveform ensured, subtitles preserved`)
      return
    }

    // Transcription input: local Whisper gets the cached mono 16 kHz 128 kbps mp3
    // as-is (no size limit). OpenAI enforces a 25 MB upload cap, so we send a
    // compact AAC-LC copy (mono 16 kHz 48 kbps) — transparent for speech and
    // ~21 MB at the 60-minute ceiling (videos over that are gated out above).
    let whisperAudioPath = audioMp3Path
    let whisperFileName = 'audio.mp3'
    let whisperMimeType = 'audio/mpeg'
    if (config.provider === 'OPENAI') {
      const aacPath = path.join(tempDir, 'audio-openai.m4a')
      await extractAudioForTranscription(audioMp3Path, aacPath, 'aac', OPENAI_AAC_KBPS)
      const aacBytes = (await fs.promises.stat(aacPath)).size
      // Backstop for unknown/mis-reported durations that slip past the 60-min gate.
      if (aacBytes > OPENAI_AUDIO_UPLOAD_CAP_BYTES) {
        throw new Error(`Extracted audio is ${(aacBytes / 1048576).toFixed(1)} MB, over OpenAI's 25 MB upload cap — the video is too long for the OpenAI provider.`)
      }
      whisperAudioPath = aacPath
      whisperFileName = 'audio.m4a'
      whisperMimeType = 'audio/mp4'
    }

    console.log(`[transcription] Transcribing video ${videoId} via ${config.provider} (${config.model})`)
    const rawSrt = await whisperTranscribe({
      config,
      audio: whisperAudioPath,
      fileName: whisperFileName,
      mimeType: whisperMimeType,
      responseFormat: 'srt',
      timeoutMs: VIDEO_TRANSCRIBE_TIMEOUT_MS,
    })

    let cues = parseSrt(rawSrt)
    if (cues.length === 0) {
      // No detectable speech (music-only cut, silent b-roll). Nothing to attach —
      // READY with no asset means the player simply shows no CC button.
      console.log(`[transcription] Video ${videoId}: no speech detected — no subtitles generated`)
      await prisma.video.update({
        where: { id: videoId },
        data: { transcriptionStatus: 'READY', transcriptionError: null },
      })
      return
    }

    // Collapse Whisper's end-of-audio hallucination loops (runs of adjacent
    // identical short cues over trailing silence), then re-flow for on-screen
    // readability (max chars/line + max lines), then canonically re-serialize so
    // the stored SRT matches what parseSrt returns to the edit API.
    cues = collapseRepeatedCues(cues)
    cues = reflowCues(cues, { maxCharsPerLine: config.maxCharsPerLine, maxLines: config.maxLines })
    const srtText = serializeSrt(cues)
    const vttText = serializeVtt(cues)

    const srtStoragePath = `${storageRoot}/captions.srt`
    const vttStoragePath = `${storageRoot}/captions.vtt`

    const tempSrtPath = path.join(tempDir, 'captions.srt')
    const tempVttPath = path.join(tempDir, 'captions.vtt')
    await fs.promises.writeFile(tempSrtPath, srtText, 'utf-8')
    await fs.promises.writeFile(tempVttPath, vttText, 'utf-8')

    const srtSize = Buffer.byteLength(srtText, 'utf-8')
    const vttSize = Buffer.byteLength(vttText, 'utf-8')
    await uploadFileFromPath(srtStoragePath, tempSrtPath, srtSize, 'application/x-subrip')
    await uploadFileFromPath(vttStoragePath, tempVttPath, vttSize, 'text/vtt')

    // One subtitles VideoAsset per video, upserted — regeneration reuses the row
    const fileName = sanitizeSubtitleFileName(video.name, video.versionLabel)
    const existingAsset = await prisma.videoAsset.findFirst({
      where: { videoId, category: 'subtitles' },
      select: { id: true },
    })
    const asset = existingAsset
      ? await prisma.videoAsset.update({
          where: { id: existingAsset.id },
          data: { fileName, fileType: 'application/x-subrip' },
          select: { id: true },
        })
      : await prisma.videoAsset.create({
          data: {
            videoId,
            fileName,
            fileType: 'application/x-subrip',
            category: 'subtitles',
            uploadedByName: 'Auto-generated (Whisper)',
          },
          select: { id: true },
        })

    await registerStoredFiles([
      {
        entityType: 'VIDEO_ASSET',
        entityId: asset.id,
        fileRole: 'ORIGINAL',
        storagePath: srtStoragePath,
        fileName,
        fileSize: srtSize,
        status: 'READY',
      },
      {
        entityType: 'VIDEO',
        entityId: videoId,
        fileRole: 'SUBTITLES_VTT',
        storagePath: vttStoragePath,
        fileName: 'captions.vtt',
        fileSize: vttSize,
        status: 'READY',
      },
    ])

    await prisma.video.update({
      where: { id: videoId },
      data: { transcriptionStatus: 'READY', transcriptionError: null },
    })

    await Promise.all([
      recalculateAndStoreProjectTotalBytes(video.projectId),
      recalculateAndStoreProjectPreviewBytes(video.projectId),
      recalculateAndStoreProjectDiskBytes(video.projectId),
    ])

    console.log(`[transcription] Video ${videoId}: ${cues.length} cues generated`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[transcription] Video ${videoId} failed: ${message}`)
    // Only mark subtitles FAILED when we were actually (re)generating them — a
    // failure while only healing the waveform must not clobber good subtitles.
    if (!subtitlesUpToDate) {
      await prisma.video.update({
        where: { id: videoId },
        data: { transcriptionStatus: 'FAILED', transcriptionError: message.slice(0, MAX_ERROR_LENGTH) },
      }).catch(() => {})
    }
    throw error // let BullMQ retry/backoff apply
  } finally {
    if (materializedTemporary || fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Dictation + connection test (state lives on the AiAssistantRequest row)
// ---------------------------------------------------------------------------

async function claimRequest(requestId: string) {
  const request = await prisma.aiAssistantRequest.findUnique({ where: { id: requestId } })
  if (!request) {
    console.warn(`[transcription] Request ${requestId} not found — skipping`)
    return null
  }
  // Idempotency: only ever process a request once, even if the job is re-delivered
  if (request.status !== 'QUEUED') {
    if (DEBUG) console.log(`[transcription] Request ${requestId} is ${request.status} — skipping`)
    return null
  }
  await prisma.aiAssistantRequest.update({
    where: { id: requestId },
    data: { status: 'PROCESSING', error: null },
  })
  return request
}

async function markRequestFailed(requestId: string, error: unknown, resultJson?: Prisma.InputJsonValue) {
  const message = error instanceof Error ? error.message : String(error)
  await prisma.aiAssistantRequest.update({
    where: { id: requestId },
    data: {
      status: 'FAILED',
      error: message.slice(0, MAX_ERROR_LENGTH),
      ...(resultJson !== undefined ? { resultJson } : {}),
      completedAt: new Date(),
    },
  }).catch(() => {})
}

async function processDictation(requestId: string) {
  const request = await claimRequest(requestId)
  if (!request) return

  try {
    const config = await getWhisperConfig()
    if (!config.enabled) throw new WhisperNotConfiguredError()

    const attachments = Array.isArray(request.attachmentsJson)
      ? (request.attachmentsJson as unknown as AiRequestAttachment[])
      : []
    const audio = attachments.find((a) => a.kind === 'audio' && a.contentBase64)
    if (!audio?.contentBase64) {
      throw new Error('Dictation request has no audio attachment')
    }

    const buffer = Buffer.from(audio.contentBase64, 'base64')
    const text = (
      await whisperTranscribe({
        config,
        audio: buffer,
        fileName: audio.fileName || 'dictation.webm',
        mimeType: audio.mimeType || 'audio/webm',
        responseFormat: 'json',
        timeoutMs: DICTATION_TRANSCRIBE_TIMEOUT_MS,
      })
    ).trim()

    // Drop the raw base64 from the DB now that it has been consumed
    const strippedAttachments = attachments.map(({ contentBase64: _omit, ...rest }) => rest)

    await prisma.aiAssistantRequest.update({
      where: { id: requestId },
      data: {
        status: 'COMPLETED',
        resultJson: { dictation: { text } } as unknown as Prisma.InputJsonValue,
        attachmentsJson: strippedAttachments as unknown as Prisma.InputJsonValue,
        provider: `WHISPER:${config.model}`,
        completedAt: new Date(),
      },
    })
  } catch (error) {
    console.error(`[transcription] Dictation ${requestId} failed:`, error)
    await markRequestFailed(requestId, error)
    // No rethrow: dictation jobs are attempts: 1 — the admin is actively
    // polling and sees the FAILED row immediately.
  }
}

async function processWhisperTest(requestId: string) {
  const request = await claimRequest(requestId)
  if (!request) return

  try {
    const config = await getWhisperConfig()
    if (!config.url) throw new WhisperNotConfiguredError('Whisper server URL is not configured.')

    const detail = await whisperTestConnection(config)
    await prisma.aiAssistantRequest.update({
      where: { id: requestId },
      data: {
        status: 'COMPLETED',
        resultJson: { connectionTest: { ok: true, detail } } as unknown as Prisma.InputJsonValue,
        provider: `WHISPER:${config.model}`,
        completedAt: new Date(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[transcription] Whisper test ${requestId} failed: ${message}`)
    await markRequestFailed(requestId, error, {
      connectionTest: { ok: false, detail: message.slice(0, MAX_ERROR_LENGTH) },
    } as unknown as Prisma.InputJsonValue)
  }
}
