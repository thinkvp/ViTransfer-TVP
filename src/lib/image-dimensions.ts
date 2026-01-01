export type ImageType = 'png' | 'jpeg'

export function detectImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= 8) {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const isPng = pngSig.every((b, i) => buffer[i] === b)
    if (isPng) return 'png'
  }

  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  }

  return null
}

export function getPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null

  if (
    buffer[12] !== 0x49 ||
    buffer[13] !== 0x48 ||
    buffer[14] !== 0x44 ||
    buffer[15] !== 0x52
  ) {
    return null
  }

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

export function getJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4) return null
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }

    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) break

    const marker = buffer[offset]
    offset += 1

    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker >= 0xd0 && marker <= 0xd7) continue

    if (offset + 2 > buffer.length) break
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2) return null

    const segmentStart = offset + 2

    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc

    if (isSof) {
      if (segmentStart + 5 > buffer.length) return null
      const height = buffer.readUInt16BE(segmentStart + 1)
      const width = buffer.readUInt16BE(segmentStart + 3)

      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
      return { width, height }
    }

    offset += segmentLength
  }

  return null
}

export function getImageDimensions(buffer: Buffer): { type: ImageType; width: number; height: number } | null {
  const type = detectImageType(buffer)
  if (!type) return null

  const dims = type === 'png' ? getPngDimensions(buffer) : getJpegDimensions(buffer)
  if (!dims) return null

  return { type, ...dims }
}
