import sharp from 'sharp'

/** Max pixels on the longest edge for stored receipt/attachment images */
const MAX_LONG_EDGE = 2400

/**
 * JPEG quality: 82 gives a good balance —
 * readable text in receipts, noticeably smaller than full quality.
 */
const JPEG_QUALITY = 82

export interface ProcessedImage {
  buffer: Buffer
  mimeType: string
  ext: string
}

/**
 * Resize and compress an uploaded image buffer.
 * - PDFs pass through unchanged.
 * - JPEG / PNG / WebP images are resized so the long edge is at most MAX_LONG_EDGE,
 *   then re-encoded as JPEG at JPEG_QUALITY. No up-scaling.
 */
export async function processImageBuffer(buffer: Buffer, mimeType: string): Promise<ProcessedImage> {
  if (mimeType === 'application/pdf') {
    return { buffer, mimeType, ext: 'pdf' }
  }

  const processed = await sharp(buffer)
    .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()

  return { buffer: processed, mimeType: 'image/jpeg', ext: 'jpg' }
}
