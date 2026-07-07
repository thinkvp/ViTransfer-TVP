/**
 * Cached transcription audio — a small mono 16 kHz mp3 stored in the previews
 * tree alongside the subtitles/waveform so (re)generating subtitles never has to
 * re-download the full original from storage.
 *
 * It is deliberately an mp3, not a WAV: both Whisper providers accept mp3
 * directly and it's much smaller than PCM (cheaper storage + regen bandwidth).
 * 128 kbps mono @ 16 kHz is effectively lossless for speech; local Whisper
 * always gets it in full. OpenAI's 25 MB upload cap is handled adaptively at send time
 * (a one-off lower-bitrate re-encode only when the duration requires it — see
 * transcription-processor). The rare time waveform peaks are (re)computed, the
 * mp3 is decoded to WAV locally.
 */
import fs from 'fs'
import { prisma } from './db'
import { buildVideoSubtitlesStorageRoot } from './project-storage-paths'
import { uploadFileFromPath } from './storage'
import { registerStoredFiles } from './stored-file'

/** Cache bitrate (kbps) — effectively lossless for 16 kHz mono speech. */
export const TRANSCRIPTION_AUDIO_MP3_KBPS = 128

/** OpenAI rejects uploads over 25 MB; aim under this with headroom for form overhead. */
export const OPENAI_AUDIO_UPLOAD_CAP_BYTES = 24 * 1024 * 1024

/**
 * For OpenAI we send a compact AAC-LC (mono 16 kHz) copy — transparent for
 * speech and ~21 MB at the 60-minute ceiling, so anything under the cap below
 * fits comfortably. AAC is far more efficient than mp3 at low bitrates.
 */
export const OPENAI_AAC_KBPS = 48

/**
 * Max video length OpenAI transcription supports. Above this, 60 min of audio no
 * longer fits under the 25 MB upload cap at a sane bitrate, so we skip
 * auto-captions. Local Whisper has no size limit and is not gated by this.
 */
export const OPENAI_MAX_DURATION_SEC = 60 * 60

/** Storage path of a video version's cached transcription audio (under previews). */
export function buildTranscriptionAudioStoragePath(projectId: string, videoId: string): string {
  return `${buildVideoSubtitlesStorageRoot(projectId, videoId)}/audio.mp3`
}

/**
 * Upload an already-extracted transcription mp3 and register it as the video's
 * TRANSCRIPTION_AUDIO StoredFile. The caller owns the temp `mp3LocalPath`.
 */
export async function storeTranscriptionAudio(params: {
  videoId: string
  projectId: string
  mp3LocalPath: string
}): Promise<{ storagePath: string; fileSize: number }> {
  const { videoId, projectId, mp3LocalPath } = params
  const fileSize = (await fs.promises.stat(mp3LocalPath)).size
  const storagePath = buildTranscriptionAudioStoragePath(projectId, videoId)
  await uploadFileFromPath(storagePath, mp3LocalPath, fileSize, 'audio/mpeg')
  await registerStoredFiles([
    {
      entityType: 'VIDEO',
      entityId: videoId,
      fileRole: 'TRANSCRIPTION_AUDIO',
      storagePath,
      fileName: 'audio.mp3',
      fileSize,
      status: 'READY',
    },
  ])
  return { storagePath, fileSize }
}

/** Cheap check of whether the transcription feature is enabled. */
export async function isTranscriptionEnabled(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { transcriptionEnabled: true },
  })
  return settings?.transcriptionEnabled === true
}
