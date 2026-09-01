'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { cn, formatFileSize } from '@/lib/utils'
import {
  MAX_BUFFERED_PREVIEW_BYTES,
  canOpenInNewTab,
  getPreviewExtension,
  getPreviewMimeType,
  getPreviewMode,
  parseDelimitedText,
  type PreviewMode,
} from '@/lib/document-preview'
import { MAX_DOCX_PREVIEW_BYTES, convertDocxToSafeHtml } from '@/lib/docx-preview'
import {
  MAX_SHEET_PREVIEW_BYTES,
  parseSpreadsheet,
  type SheetPreviewSheet,
} from '@/lib/sheet-preview'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileQuestion,
  Loader2,
} from 'lucide-react'

export interface DocumentViewerFile {
  /** Stable key for React and for cache-busting the resolved source. */
  id: string
  fileName: string
  fileSize?: number | string | null
  /** Stored MIME type, if the surface has one. Only used as a fallback. */
  fileType?: string | null
}

interface DocumentViewerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The files the viewer can page through. Pass the whole visible list, not just the
   * previewable ones — arrowing onto an unpreviewable file shows the download fallback,
   * which is less surprising than having it silently skipped.
   */
  files: DocumentViewerFile[]
  index: number
  onIndexChange: (index: number) => void
  /**
   * The surface's existing download URL for a file. The viewer appends its own query
   * parameters; anything already on the URL is preserved. Ignored when `resolveSrc` is given.
   */
  resolveUrl?: (file: DocumentViewerFile) => string
  /**
   * Alternative to `resolveUrl` for surfaces whose files are addressed by a capability
   * token in the URL rather than by an Authorization header — the share page mints a
   * short-lived content token per file. The returned URL is loaded directly (so it must
   * already serve the file inline), and fetched without credentials when the mode needs
   * the bytes. Return null when no token could be minted.
   */
  resolveSrc?: (file: DocumentViewerFile) => Promise<string | null>
  /**
   * How to make an authenticated request. Defaults to apiFetch (admin bearer token);
   * share-page surfaces pass their own so the share token is attached instead.
   */
  fetcher?: (url: string) => Promise<Response>
  /** Runs the surface's normal download flow. The Download button is hidden without it. */
  onDownload?: (file: DocumentViewerFile) => void | Promise<void>
}

type ResolvedSource =
  /** A URL the browser can load directly — presigned S3, no bytes through the app. */
  | { kind: 'remote'; src: string }
  /** An object URL over bytes we buffered (local storage mode). Must be revoked. */
  | { kind: 'blob'; src: string }
  /** Decoded text, rendered inline. */
  | { kind: 'text'; text: string }
  /** Delimited data, rendered as a table. */
  | { kind: 'csv'; rows: string[][] }
  /** Sanitized HTML converted in the browser from a .docx. */
  | { kind: 'html'; html: string; warnings: string[] }
  /** Worksheets parsed in the browser from a spreadsheet. */
  | { kind: 'sheet'; sheets: SheetPreviewSheet[] }

function withViewerParams(url: string, wantsUrl: boolean): string {
  const [base, hash] = url.split('#')
  const separator = base.includes('?') ? '&' : '?'
  const params = wantsUrl ? 'inline=1&view=url' : 'inline=1'
  return `${base}${separator}${params}${hash ? `#${hash}` : ''}`
}

/**
 * Turn a response body into something renderable, according to the mode.
 *
 * Module scope so both credential paths (Authorization-header routes and token-in-URL share
 * routes) decode identically — the only thing that differs between them is how the bytes
 * were authorized, never how they are read.
 */
async function decodeBody(
  response: Response,
  target: DocumentViewerFile,
  previewMode: PreviewMode
): Promise<ResolvedSource> {
  // Size is always checked before the body is read, so an oversized file is abandoned
  // mid-stream rather than pulled down in full only to be rejected.
  const declaredSize = Number(response.headers.get('content-length') || '') || toBytes(target.fileSize)
  const refuseIfLarger = (limit: number) => {
    if (declaredSize !== null && declaredSize > limit) {
      void response.body?.cancel()
      throw new Error('This file is too large to preview. Download it instead.')
    }
  }

  if (previewMode === 'text') {
    refuseIfLarger(MAX_BUFFERED_PREVIEW_BYTES)
    return { kind: 'text', text: await response.text() }
  }

  if (previewMode === 'csv') {
    refuseIfLarger(MAX_BUFFERED_PREVIEW_BYTES)
    const delimiter = getPreviewExtension(target.fileName) === 'tsv' ? '\t' : ','
    return { kind: 'csv', rows: parseDelimitedText(await response.text(), delimiter) }
  }

  if (previewMode === 'docx') {
    refuseIfLarger(MAX_DOCX_PREVIEW_BYTES)
    const { html, warnings } = await convertDocxToSafeHtml(await response.arrayBuffer())
    return { kind: 'html', html, warnings }
  }

  if (previewMode === 'sheet') {
    refuseIfLarger(MAX_SHEET_PREVIEW_BYTES)
    const { sheets } = await parseSpreadsheet(await response.arrayBuffer())
    return { kind: 'sheet', sheets }
  }

  // Local storage mode (or a route that does not serve view URLs): buffer the bytes.
  refuseIfLarger(MAX_BUFFERED_PREVIEW_BYTES)

  const raw = await response.blob()
  // Several download routes fall back to application/octet-stream, which the browser
  // will refuse to render. Re-wrap with the type the extension implies.
  const mimeType = getPreviewMimeType(target.fileName, target.fileType)
  const blob = raw.type === mimeType ? raw : new Blob([raw], { type: mimeType })
  return { kind: 'blob', src: URL.createObjectURL(blob) }
}

function toBytes(size: DocumentViewerFile['fileSize']): number | null {
  if (size === null || size === undefined) return null
  const parsed = typeof size === 'number' ? size : Number(size)
  return Number.isFinite(parsed) ? parsed : null
}

export function DocumentViewerModal({
  open,
  onOpenChange,
  files,
  index,
  onIndexChange,
  resolveUrl,
  resolveSrc,
  fetcher,
  onDownload,
}: DocumentViewerModalProps) {
  const [source, setSource] = useState<ResolvedSource | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)

  // Object URLs are revoked from a ref rather than from the effect's closure so that a
  // rapid prev/next never leaks the URL of a load that was superseded mid-flight.
  const objectUrlRef = useRef<string | null>(null)
  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const file: DocumentViewerFile | undefined = files[index]
  const mode: PreviewMode = file ? getPreviewMode(file.fileName) : 'none'

  // The loader keys off the file's *identity fields*, never the object or the callbacks.
  // Call sites build `files` and `resolveUrl` inline (they are cheap), so depending on
  // their references would restart the fetch on every parent render — the same refetch
  // loop that has bitten the share page before.
  const fileId = file?.id ?? null
  const fileName = file?.fileName ?? null
  const fileType = file?.fileType ?? null
  const fileSize = toBytes(file?.fileSize)
  // Synced in an effect rather than during render: writing a ref while rendering is not a
  // pure render, and this effect is declared above the loader so it always lands first.
  const latest = useRef({ resolveUrl, resolveSrc, fetcher })
  useEffect(() => {
    latest.current = { resolveUrl, resolveSrc, fetcher }
  })

  useEffect(() => {
    if (!open || !fileId || !fileName || mode === 'none') {
      setSource(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    const { resolveUrl: resolve, resolveSrc: resolveDirect, fetcher: customFetcher } = latest.current
    const request = customFetcher ?? apiFetch
    const target: DocumentViewerFile = { id: fileId, fileName, fileType, fileSize }

    setLoading(true)
    setError(null)
    setSource(null)

    async function load(target: DocumentViewerFile, previewMode: PreviewMode) {
      // Text has to be decoded here, so there is nothing to gain from a direct S3 URL —
      // and asking for one would force a second cross-origin fetch. PDFs and images are
      // handed to the browser as a URL whenever storage can produce one.
      const wantsUrl = previewMode === 'pdf' || previewMode === 'image'

      // Token-in-URL surfaces (the share page) hand us a URL that already serves the file
      // inline, so there is nothing to negotiate: frame it, or fetch it plainly when the
      // mode needs bytes to decode. No credentials — the capability is the token itself.
      if (resolveDirect) {
        const src = await resolveDirect(target)
        if (!src) throw new Error('This file is no longer available.')
        if (wantsUrl) return { kind: 'remote' as const, src }
        const direct = await fetch(src)
        if (!direct.ok) throw new Error(`Could not open this file (${direct.status}).`)
        return decodeBody(direct, target, previewMode)
      }

      if (!resolve) throw new Error('Could not open this file.')
      const response = await request(withViewerParams(resolve(target), wantsUrl))

      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(detail?.error || `Could not open this file (${response.status}).`)
      }

      const contentType = response.headers.get('content-type') || ''

      // S3 mode: the route answered with a presigned inline URL instead of the bytes.
      if (wantsUrl && contentType.includes('application/json')) {
        const payload = await response.json().catch(() => null)
        if (payload?.url && typeof payload.url === 'string') {
          return { kind: 'remote' as const, src: payload.url }
        }
        throw new Error('Could not open this file.')
      }

      return decodeBody(response, target, previewMode)
    }

    void load(target, mode)
      .then((resolved) => {
        if (cancelled) {
          if (resolved.kind === 'blob') URL.revokeObjectURL(resolved.src)
          return
        }
        releaseObjectUrl()
        if (resolved.kind === 'blob') objectUrlRef.current = resolved.src
        setSource(resolved)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not open this file.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, fileId, fileName, fileType, fileSize, mode, releaseObjectUrl])

  // Paging to another workbook must not land on the previous one's tab index.
  useEffect(() => { setActiveSheet(0) }, [fileId])

  // Release the buffered bytes as soon as the viewer closes; a few large previews left
  // resident add up in a long admin session.
  useEffect(() => {
    if (!open) releaseObjectUrl()
  }, [open, releaseObjectUrl])
  useEffect(() => releaseObjectUrl, [releaseObjectUrl])

  const hasMultiple = files.length > 1
  const goPrev = useCallback(() => {
    if (files.length > 1) onIndexChange((index - 1 + files.length) % files.length)
  }, [files.length, index, onIndexChange])
  const goNext = useCallback(() => {
    if (files.length > 1) onIndexChange((index + 1) % files.length)
  }, [files.length, index, onIndexChange])

  useEffect(() => {
    if (!open || !hasMultiple) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); goPrev() }
      if (event.key === 'ArrowRight') { event.preventDefault(); goNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hasMultiple, goPrev, goNext])

  if (!file) return null

  const sizeBytes = toBytes(file.fileSize)
  // Only the URL-backed kinds have something a frame or a new tab can point at; the
  // decoded kinds (text, csv, converted docx) are rendered from data we already hold.
  const externalSrc = source && (source.kind === 'remote' || source.kind === 'blob') ? source.src : null
  const canPopOut = Boolean(externalSrc) && canOpenInNewTab(file.fileName)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-6xl w-[95vw] h-[90vh] p-0 gap-0 flex flex-col overflow-hidden"
        description={`Preview of ${file.fileName}`}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 pr-12 shrink-0">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold" title={file.fileName}>
              {file.fileName}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {sizeBytes !== null ? formatFileSize(sizeBytes) : null}
              {sizeBytes !== null && hasMultiple ? ' • ' : null}
              {hasMultiple ? `${index + 1} of ${files.length}` : null}
            </p>
          </div>

          {canPopOut && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.open(externalSrc!, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink className="w-4 h-4" />
              <span className="hidden sm:inline">Open</span>
            </Button>
          )}
          {onDownload && (
            <Button type="button" variant="outline" size="sm" onClick={() => void onDownload(file)}>
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Download</span>
            </Button>
          )}
        </div>

        <div className="relative flex-1 min-h-0 bg-muted/30">
          {hasMultiple && (
            <>
              <NavButton side="left" onClick={goPrev} />
              <NavButton side="right" onClick={goNext} />
            </>
          )}

          {loading && <Centered><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></Centered>}

          {!loading && error && (
            <Centered>
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm text-destructive text-center max-w-sm">{error}</p>
            </Centered>
          )}

          {!loading && !error && mode === 'none' && (
            <Centered>
              <FileQuestion className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Preview isn&apos;t available for this file type. Download it to open in another app.
              </p>
            </Centered>
          )}

          {!loading && !error && source?.kind === 'text' && (
            <pre className="absolute inset-0 overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
              {source.text}
            </pre>
          )}

          {!loading && !error && source?.kind === 'csv' && (
            <div className="absolute inset-0 overflow-auto p-4">
              <DataTable rows={source.rows} />
            </div>
          )}

          {!loading && !error && source?.kind === 'sheet' && (() => {
            const sheets = source.sheets
            const sheet = sheets[Math.min(activeSheet, sheets.length - 1)]
            return (
              <div className="absolute inset-0 flex flex-col">
                {sheets.length > 1 && (
                  <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/50 px-2 py-1.5">
                    {sheets.map((s, i) => (
                      <button
                        key={`${s.name}-${i}`}
                        type="button"
                        onClick={() => setActiveSheet(i)}
                        className={cn(
                          'shrink-0 rounded px-2.5 py-1 text-xs transition-colors',
                          i === Math.min(activeSheet, sheets.length - 1)
                            ? 'bg-background font-medium text-foreground shadow-elevation-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {s.name || `Sheet ${i + 1}`}
                      </button>
                    ))}
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {sheet ? <DataTable rows={sheet.rows} /> : null}
                  {sheet?.truncated && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      This sheet is larger than the preview shows. Download the file to see all of it.
                    </p>
                  )}
                </div>
              </div>
            )
          })()}

          {!loading && !error && source?.kind === 'html' && (
            <div className="absolute inset-0 overflow-auto bg-background">
              <div
                className="docx-preview mx-auto max-w-3xl p-6 text-sm"
                // Converted by mammoth in the browser, then run through DOMPurify with a
                // fixed tag/attribute allowlist in docx-preview.ts. Nothing from the file
                // reaches this point unsanitized.
                dangerouslySetInnerHTML={{ __html: source.html }}
              />
            </div>
          )}

          {!loading && !error && externalSrc && mode === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={externalSrc}
              alt={file.fileName}
              className="absolute inset-0 m-auto max-w-full max-h-full object-contain"
            />
          )}

          {!loading && !error && externalSrc && mode === 'pdf' && (
            <iframe
              src={externalSrc}
              title={file.fileName}
              className="absolute inset-0 w-full h-full border-0 bg-background"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Shared grid for the two tabular modes (delimited text and spreadsheet worksheets). The
 * first row is treated as a header — true for essentially every export people attach, and
 * harmless when it is not.
 */
function DataTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">This file has no rows.</p>
  }

  return (
    <table className="w-max min-w-full border-collapse text-xs">
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className={rowIndex === 0 ? 'bg-muted font-semibold' : undefined}>
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className="max-w-md whitespace-pre-wrap border border-border px-2 py-1 align-top"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">
      {children}
    </div>
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous file' : 'Next file'}
      className={cn(
        'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 p-2 shadow-elevation-md',
        'text-foreground/70 hover:text-foreground hover:bg-background transition-colors',
        side === 'left' ? 'left-2' : 'right-2'
      )}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}
