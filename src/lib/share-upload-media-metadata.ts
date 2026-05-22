export type ShareUploadMediaMetadata = {
  durationSeconds: number | null
  width: number | null
  height: number | null
  codec: string | null
}

function sanitizeNumber(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0) return null
  if (value > max) return null
  return value
}

function sanitizeCodec(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 128)
}

export function parseShareUploadMediaMetadata(raw: unknown): ShareUploadMediaMetadata | null {
  if (!raw || typeof raw !== 'object') return null

  const candidate = raw as Record<string, unknown>
  const durationSeconds = sanitizeNumber(candidate.durationSeconds, 48 * 60 * 60)
  const width = sanitizeNumber(candidate.width, 16384)
  const height = sanitizeNumber(candidate.height, 16384)
  const codec = sanitizeCodec(candidate.codec)

  if (durationSeconds == null && width == null && height == null && codec == null) {
    return null
  }

  return {
    durationSeconds,
    width,
    height,
    codec,
  }
}
