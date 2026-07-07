/**
 * Read/write access to a video's auto-generated subtitles.
 *
 * The SRT file (stored as the video's `category: 'subtitles'` VideoAsset) is
 * the source of truth; every write re-serializes BOTH the SRT and the playback
 * VTT from the same cue array so they can never drift. Shared by the admin and
 * share cue-edit API routes so their semantics cannot diverge.
 */
import { prisma } from './db'
import { downloadFile, uploadFile } from './storage'
import { getStoredFilePathForProject, registerStoredFiles } from './stored-file'
import { buildVideoSubtitlesStorageRoot } from './project-storage-paths'
import { parseSrt, serializeSrt, serializeVtt, type SubtitleCue } from './subtitles'

export class SubtitlesNotFoundError extends Error {
  constructor(message = 'No subtitles exist for this video') {
    super(message)
    this.name = 'SubtitlesNotFoundError'
  }
}

async function findSubtitleAsset(videoId: string) {
  return prisma.videoAsset.findFirst({
    where: { videoId, category: 'subtitles' },
    select: { id: true, fileName: true, updatedAt: true, video: { select: { projectId: true } } },
  })
}

/** Filesystem/browser-friendly SRT name. Mirrors the worker's helper. */
function sanitizeSubtitleFileName(name: string, versionLabel: string): string {
  const base = `${name}_${versionLabel}_captions`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return `${base}.srt`
}

async function streamToString(storagePath: string): Promise<string> {
  const stream = await downloadFile(storagePath)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

export async function readCuesForVideo(videoId: string): Promise<{
  cues: SubtitleCue[]
  fileName: string
  updatedAt: Date
}> {
  const asset = await findSubtitleAsset(videoId)
  if (!asset) throw new SubtitlesNotFoundError()

  const srtPath = await getStoredFilePathForProject('VIDEO_ASSET', asset.id, 'ORIGINAL', asset.video.projectId)
  if (!srtPath) throw new SubtitlesNotFoundError('Subtitle file is not registered in storage')

  const srt = await streamToString(srtPath)
  return { cues: parseSrt(srt), fileName: asset.fileName, updatedAt: asset.updatedAt }
}

/**
 * Overwrite the video's subtitles with the given cues. Re-serializes SRT + VTT
 * and re-registers both StoredFile rows with the new sizes. The storage paths
 * already registered by the worker are reused; the deterministic builder is
 * only a fallback (e.g. VTT row missing after a partial failure).
 *
 * If the video has no `subtitles` VideoAsset yet (manual SRT upload, or captions
 * copied from another version), one is created — so this is safe to call on a
 * version that was never auto-transcribed. `opts.uploadedByName` labels the
 * source (e.g. "Uploaded (SRT)", "Copied subtitles"); defaults to Whisper's when
 * an asset already exists (untouched) or "Uploaded (SRT)" for a fresh one.
 */
export async function writeCuesForVideo(
  videoId: string,
  cues: SubtitleCue[],
  opts?: { uploadedByName?: string },
): Promise<{ cueCount: number }> {
  let asset = await findSubtitleAsset(videoId)
  if (!asset) {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { projectId: true, name: true, versionLabel: true },
    })
    if (!video) throw new SubtitlesNotFoundError('Video not found')
    const fileName = sanitizeSubtitleFileName(video.name, video.versionLabel)
    const created = await prisma.videoAsset.create({
      data: {
        videoId,
        fileName,
        fileType: 'application/x-subrip',
        category: 'subtitles',
        uploadedByName: opts?.uploadedByName ?? 'Uploaded (SRT)',
      },
      select: { id: true, fileName: true, updatedAt: true, video: { select: { projectId: true } } },
    })
    asset = created
  } else if (opts?.uploadedByName) {
    await prisma.videoAsset.update({
      where: { id: asset.id },
      data: { uploadedByName: opts.uploadedByName },
    }).catch(() => {})
  }
  const projectId = asset.video.projectId

  const srtText = serializeSrt(cues)
  const vttText = serializeVtt(cues)
  const srtSize = Buffer.byteLength(srtText, 'utf-8')
  const vttSize = Buffer.byteLength(vttText, 'utf-8')

  const storageRoot = buildVideoSubtitlesStorageRoot(projectId, videoId)
  const srtPath =
    (await getStoredFilePathForProject('VIDEO_ASSET', asset.id, 'ORIGINAL', projectId)) ??
    `${storageRoot}/captions.srt`
  const vttPath =
    (await getStoredFilePathForProject('VIDEO', videoId, 'SUBTITLES_VTT', projectId)) ??
    `${storageRoot}/captions.vtt`

  await uploadFile(srtPath, Buffer.from(srtText, 'utf-8'), srtSize, 'application/x-subrip')
  await uploadFile(vttPath, Buffer.from(vttText, 'utf-8'), vttSize, 'text/vtt')

  await registerStoredFiles([
    {
      entityType: 'VIDEO_ASSET',
      entityId: asset.id,
      fileRole: 'ORIGINAL',
      storagePath: srtPath,
      fileName: asset.fileName,
      fileSize: srtSize,
      status: 'READY',
    },
    {
      entityType: 'VIDEO',
      entityId: videoId,
      fileRole: 'SUBTITLES_VTT',
      storagePath: vttPath,
      fileName: 'captions.vtt',
      fileSize: vttSize,
      status: 'READY',
    },
  ])

  // Touch the asset row so share listings/caches see the edit
  await prisma.videoAsset.update({
    where: { id: asset.id },
    data: { updatedAt: new Date() },
  }).catch(() => {})

  return { cueCount: cues.length }
}
