/**
 * Pure policy for in-app file viewing: which uploaded files can be shown in the document
 * viewer, and what MIME type to render them as.
 *
 * Deliberately dependency-free (no Node, no React) so the same rules apply in the client
 * components that decide whether a filename is clickable and in the API routes that decide
 * whether to serve `Content-Disposition: inline`. Extension→kind classification for the
 * share-page file browser lives in downloadable-file-utils.ts; this module is the narrower
 * "can we safely render it" question and is the single source of truth for that answer.
 */

export type PreviewMode = 'image' | 'pdf' | 'text' | 'csv' | 'docx' | 'sheet' | 'none'

/**
 * Extensions that must NEVER be served inline or opened from a blob: URL, regardless of how
 * harmless the upload looks. A blob: URL inherits our origin, so framing or navigating to
 * one of these executes attacker-controlled script as us — stored XSS from any surface that
 * accepts client uploads. SVG is in the upload allowlist (branding assets), which is exactly
 * why it has to be named here: these are download-only, forever.
 */
const NEVER_INLINE_EXTENSIONS = new Set([
  'svg', 'svgz',
  'html', 'htm', 'xhtml', 'shtml', 'mhtml', 'mht',
  'xml', 'xsl', 'xslt',
  'pdf.js', // defensive: double-extension smuggling
])

/** Rendered with <img>. HEIC/HEIF are excluded — only Safari can decode them. */
const PREVIEW_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'])

/** Rendered as decoded text in a <pre>. Kept small on purpose. */
const PREVIEW_TEXT_EXTENSIONS = new Set(['txt', 'md', 'log', 'json', 'srt', 'vtt'])

/** Delimited data, rendered as a table rather than raw text. */
const PREVIEW_CSV_EXTENSIONS = new Set(['csv', 'tsv'])

/**
 * Word documents, converted to HTML in the browser (see docx-preview.ts).
 *
 * Only the OOXML format: legacy binary .doc is a completely different container that
 * mammoth cannot read, so it falls through to the download fallback.
 */
const PREVIEW_DOCX_EXTENSIONS = new Set(['docx'])

/**
 * Spreadsheets, parsed in the browser by SheetJS (see sheet-preview.ts). SheetJS reads the
 * legacy BIFF .xls container as well as OOXML, so both are previewable. PowerPoint has no
 * converter in the tree and stays download-only.
 */
const PREVIEW_SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm'])

/**
 * Upper bound on what the viewer will pull down before giving up and offering a download
 * instead. Only applies to the modes that must buffer the bytes (text, and anything served
 * from local storage); S3-mode images and PDFs stream straight from the presigned URL and
 * are not subject to it.
 */
export const MAX_BUFFERED_PREVIEW_BYTES = 50 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  md: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  srt: 'text/plain',
  vtt: 'text/vtt',
}

/** Lowercased extension without the dot, or '' when the name has none. */
export function getPreviewExtension(fileName: string): string {
  const safeName = typeof fileName === 'string' ? fileName : ''
  const dotIndex = safeName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === safeName.length - 1) return ''
  return safeName.slice(dotIndex + 1).toLowerCase()
}

/**
 * How this file should be rendered, if at all.
 *
 * Classification is driven by the filename extension rather than the stored MIME type: the
 * MIME type is browser-reported at upload time and is routinely wrong or absent (see the
 * extension fallbacks in upload-policy.ts), whereas the extension is what every other file
 * decision in this codebase already keys off.
 */
export function getPreviewMode(fileName: string): PreviewMode {
  const ext = getPreviewExtension(fileName)
  if (!ext) return 'none'
  if (NEVER_INLINE_EXTENSIONS.has(ext)) return 'none'
  if (ext === 'pdf') return 'pdf'
  if (PREVIEW_IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PREVIEW_CSV_EXTENSIONS.has(ext)) return 'csv'
  if (PREVIEW_DOCX_EXTENSIONS.has(ext)) return 'docx'
  if (PREVIEW_SHEET_EXTENSIONS.has(ext)) return 'sheet'
  if (PREVIEW_TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'none'
}

export function canPreviewFile(fileName: string): boolean {
  return getPreviewMode(fileName) !== 'none'
}

/**
 * Whether this file must never be served with `Content-Disposition: inline`, whatever the
 * caller asked for.
 *
 * Distinct from `!canPreviewFile()`: plenty of files are unpreviewable but harmless inline
 * (a video streamed for playback, an unknown binary). This is the narrower, hard "serving
 * this inline on our own origin hands the uploader script execution as us" set, and it is
 * what routes that stream arbitrary client uploads should gate on.
 */
export function isNeverInlineFile(fileName: string): boolean {
  return NEVER_INLINE_EXTENSIONS.has(getPreviewExtension(fileName))
}

/**
 * MIME type to render the bytes as. Never trusts the stored type for a previewable file —
 * several download routes fall back to `application/octet-stream`, which would make the
 * browser refuse to display an otherwise perfectly good PDF.
 */
export function getPreviewMimeType(fileName: string, storedType?: string | null): string {
  const ext = getPreviewExtension(fileName)
  const known = MIME_BY_EXTENSION[ext]
  if (known) return known
  const trimmed = typeof storedType === 'string' ? storedType.trim() : ''
  if (trimmed && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)) return trimmed
  return 'application/octet-stream'
}

/**
 * Whether it is safe to hand this file to a new browser tab. Blob URLs inherit our origin,
 * so this must stay in lockstep with NEVER_INLINE_EXTENSIONS — anything unpreviewable is
 * also unsafe to navigate to.
 */
export function canOpenInNewTab(fileName: string): boolean {
  return canPreviewFile(fileName)
}

/**
 * Whether an <img src> produced by document conversion may be kept.
 *
 * Raster `data:` URIs (how mammoth inlines embedded pictures) and ordinary http(s) URLs
 * only. `data:image/svg+xml` is refused: an SVG is a script host, and DOMPurify will not
 * catch it for us — it permits `data:` on <img> through a path that ALLOWED_URI_REGEXP is
 * never consulted for, which is exactly the hole this function exists to close.
 */
export function isSafeInlineImageSrc(value: string | null | undefined): boolean {
  const src = (value ?? '').trim()
  if (!src) return false
  if (/^https?:\/\//i.test(src)) return true
  return /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,[a-z0-9+/=\s]*$/i.test(src)
}

/** Whether an <a href> produced by document conversion may be kept. */
export function isSafeLinkHref(value: string | null | undefined): boolean {
  const href = (value ?? '').trim()
  if (!href) return false
  return /^(?:https?:\/\/|mailto:)/i.test(href)
}

/**
 * Split delimited text into rows. Handles RFC 4180 quoting (doubled quotes inside a quoted
 * field, and delimiters/newlines that appear within one) because spreadsheet exports rely
 * on it — a naive split on commas mangles any cell containing a comma.
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  // Normalise line endings first so CRLF exports do not leave stray \r in cells.
  const input = text.replace(/\r\n?/g, '\n')

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') { inQuotes = true }
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else { field += char }
  }

  // Trailing field/row, unless the file simply ended with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
