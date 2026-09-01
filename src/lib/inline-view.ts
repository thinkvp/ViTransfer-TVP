/**
 * Server-side plumbing for the in-app document viewer.
 *
 * Every file-serving route in this app already enforces its own auth + RBAC before it
 * resolves a storage path. The viewer deliberately reuses those routes rather than adding a
 * generic "preview any file by id" endpoint, because such an endpoint would have to
 * re-implement each surface's authorization and `npm run check:rbac` cannot see inside it.
 * These helpers are therefore intentionally dumb: they answer "was inline viewing asked
 * for?" and "can this be handed over as a direct S3 URL?", and nothing else. The caller has
 * already decided the requester is allowed to see the bytes.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { canPreviewFile, getPreviewMimeType } from '@/lib/document-preview'
import { isS3Mode, s3GetPresignedInlineUrl } from '@/lib/s3-storage'

/** Presigned viewer URLs are short-lived; the modal re-requests one each time it opens. */
export const INLINE_VIEW_URL_TTL_SECONDS = 300

/** True when the caller asked for `Content-Disposition: inline` (`?inline=1`). */
export function wantsInlineView(request: NextRequest): boolean {
  return new URL(request.url).searchParams.get('inline') === '1'
}

/**
 * True when the caller wants a *URL* to the bytes rather than the bytes themselves
 * (`?inline=1&view=url`). Only meaningful in S3 mode.
 */
export function wantsInlineViewUrl(request: NextRequest): boolean {
  const params = new URL(request.url).searchParams
  return params.get('inline') === '1' && params.get('view') === 'url'
}

/**
 * Content-Disposition value for a route streaming bytes itself (local storage mode).
 *
 * Refuses to go inline for anything the preview policy rejects, so a crafted `?inline=1` on
 * an uploaded .html or .svg can never turn a download route into a same-origin script host.
 */
export function contentDispositionFor(
  request: NextRequest,
  fileName: string,
  sanitizedFileName: string
): string {
  const inline = wantsInlineView(request) && canPreviewFile(fileName)
  return `${inline ? 'inline' : 'attachment'}; filename="${sanitizedFileName}"; ` +
    `filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/**
 * In S3 mode, answer a `?inline=1&view=url` request with a presigned inline URL that the
 * browser can point an <iframe>/<img> at directly.
 *
 * This is the whole point of the parameter: documents stream from R2 to the viewer without
 * transiting the app, so a large PDF opens as fast as the client's link allows instead of
 * being relayed (and buffered) by the server.
 *
 * Returns null when the request did not ask for a URL, when local storage is in use, or
 * when the file is not safe to render inline — in every one of those cases the caller
 * should carry on with its normal streaming/redirect path.
 */
export async function inlineViewUrlResponse(
  request: NextRequest,
  file: { key: string; fileName: string; contentType?: string | null }
): Promise<NextResponse | null> {
  if (!wantsInlineViewUrl(request)) return null
  if (!isS3Mode()) return null
  if (!canPreviewFile(file.fileName)) return null

  const contentType = getPreviewMimeType(file.fileName, file.contentType)
  const url = await s3GetPresignedInlineUrl(
    file.key,
    INLINE_VIEW_URL_TTL_SECONDS,
    file.fileName,
    contentType
  )

  return NextResponse.json(
    { url, contentType, expiresIn: INLINE_VIEW_URL_TTL_SECONDS },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
