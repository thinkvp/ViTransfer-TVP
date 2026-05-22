export type UploadMediaMetadata = {
  durationSeconds?: number
  width?: number
  height?: number
  codec?: string
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0) return undefined
  return value
}

function normalizeCodec(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}

function parseCodecFromMimeType(mimeType: string): string | undefined {
  const mime = String(mimeType || '')
  const match = mime.match(/codecs?\s*=\s*"?([^";]+)"?/i)
  if (!match) return undefined
  return normalizeCodec(match[1])
}

function isVideoOrAudio(file: File): boolean {
  const mimeType = String(file.type || '').toLowerCase()
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return true
  const name = String(file.name || '').toLowerCase()
  return /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|aac|m4a|ogg)$/i.test(name)
}

export async function extractUploadMediaMetadata(file: File): Promise<UploadMediaMetadata | null> {
  if (!isVideoOrAudio(file)) return null

  const objectUrl = URL.createObjectURL(file)

  try {
    const media = document.createElement('video')
    media.preload = 'metadata'
    media.muted = true
    media.playsInline = true

    const metadata = await new Promise<UploadMediaMetadata | null>((resolve) => {
      let settled = false

      const finish = (value: UploadMediaMetadata | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const timeoutId = window.setTimeout(() => finish(null), 7000)

      media.onloadedmetadata = () => {
        window.clearTimeout(timeoutId)
        finish({
          durationSeconds: normalizeFiniteNumber(media.duration),
          width: normalizeFiniteNumber(media.videoWidth),
          height: normalizeFiniteNumber(media.videoHeight),
          codec: normalizeCodec(parseCodecFromMimeType(file.type)),
        })
      }

      media.onerror = () => {
        window.clearTimeout(timeoutId)
        finish(null)
      }

      media.src = objectUrl
    })

    if (!metadata) return null

    const normalized: UploadMediaMetadata = {}
    if (metadata.durationSeconds) normalized.durationSeconds = metadata.durationSeconds
    if (metadata.width) normalized.width = metadata.width
    if (metadata.height) normalized.height = metadata.height
    if (metadata.codec) normalized.codec = metadata.codec

    return Object.keys(normalized).length > 0 ? normalized : null
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
