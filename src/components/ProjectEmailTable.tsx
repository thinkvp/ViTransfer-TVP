'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatFileSize } from '@/lib/utils'
import { ArrowDown, ArrowUp, Loader2, Paperclip, Trash2, Download, ChevronDown, ChevronRight } from 'lucide-react'

type SortKey = 'sentAt' | 'subject' | 'from' | 'attachments'

type ProjectEmailRow = {
  id: string
  subject: string | null
  fromName: string | null
  fromEmail: string | null
  sentAt: string | null
  attachmentsCount: number
  hasAttachments: boolean
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  errorMessage: string | null
  createdAt: string
}

type ProjectEmailAttachment = {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  isInline: boolean
  contentId: string | null
  createdAt: string
  downloadUrl: string
}

type ProjectEmailDetail = {
  id: string
  subject: string | null
  fromName: string | null
  fromEmail: string | null
  sentAt: string | null
  textBody: string | null
  htmlBody: string | null
  hasAttachments: boolean
  attachmentsCount: number
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  errorMessage: string | null
  createdAt: string
  attachments: ProjectEmailAttachment[]
}

interface ProjectEmailTableProps {
  projectId: string
  refreshTrigger?: number
  canDelete?: boolean
  onExternalFilesChanged?: () => void
}

function formatEmailDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function displayFrom(row: { fromName: string | null }) {
  const name = (row.fromName || '').trim()
  return name || '—'
}

export function ProjectEmailTable({ projectId, refreshTrigger, canDelete = true, onExternalFilesChanged }: ProjectEmailTableProps) {
  const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
  const MAX_INLINE_IMAGES_TO_PREFETCH = 10
  const MAX_HTML_CHARS_FOR_INLINE_REWRITE = 500_000

  const [emails, setEmails] = useState<ProjectEmailRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const perPage = 10
  const [totalPages, setTotalPages] = useState(1)

  const [sortKey, setSortKey] = useState<SortKey>('sentAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<ProjectEmailDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [expandedMobileId, setExpandedMobileId] = useState<string | null>(null)

  async function loadList(nextPage = page, nextSortKey = sortKey, nextSortDir = sortDir) {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/emails?page=${nextPage}&perPage=${perPage}&sortKey=${encodeURIComponent(nextSortKey)}&sortDir=${encodeURIComponent(nextSortDir)}`
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch emails')
      }
      const data = await res.json()
      setEmails(Array.isArray(data?.emails) ? data.emails : [])
      setTotalPages(Number.isFinite(data?.totalPages) ? data.totalPages : 1)
    } catch (e: any) {
      setError(e?.message || 'Failed to load emails')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadList(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshTrigger])

  useEffect(() => {
    void loadList(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sortKey, sortDir])

  const hasProcessingEmails = useMemo(() => {
    return emails.some((e) => e.status === 'UPLOADING' || e.status === 'PROCESSING')
  }, [emails])

  const hadProcessingEmailsRef = useRef(false)
  useEffect(() => {
    if (hadProcessingEmailsRef.current && !hasProcessingEmails) {
      onExternalFilesChanged?.()
    }
    hadProcessingEmailsRef.current = hasProcessingEmails
  }, [hasProcessingEmails, onExternalFilesChanged])

  useEffect(() => {
    if (!hasProcessingEmails) return

    const interval = setInterval(() => {
      void loadList(page, sortKey, sortDir)
    }, 5000)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasProcessingEmails, page, sortKey, sortDir])

  const columns = useMemo(
    () =>
      [
        { key: 'attachments' as const, label: '', className: 'w-[60px] text-center' },
        { key: 'subject' as const, label: 'Subject', className: 'w-[55%]' },
        { key: 'from' as const, label: 'From', className: 'w-[30%]' },
        { key: 'sentAt' as const, label: 'Date', className: 'w-[170px]' },
      ] as const,
    []
  )

  const toggleSort = (key: SortKey) => {
    setPage(1)
    setSortKey((prev) => {
      if (prev !== key) {
        setSortDir(key === 'sentAt' ? 'desc' : 'asc')
        return key
      }
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return prev
    })
  }

  const closeDetail = () => {
    setDetailOpen(false)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }

  const openDetail = async (emailId: string) => {
    setDetailOpen(true)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)

    try {
      const res = await apiFetch(`/api/projects/${projectId}/emails/${emailId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to load email')
      }

      const data = await res.json()
      const email: ProjectEmailDetail | null = data?.email || null
      if (!email) throw new Error('Email not found')

      // Inline images are intentionally not rendered; attachments remain available.
      setDetail(email)
    } catch (e: any) {
      setDetailError(e?.message || 'Failed to load email')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleDelete = async (emailId: string) => {
    const row = emails.find((e) => e.id === emailId)
    const label = row?.subject?.trim() ? row.subject.trim() : 'this email'

    if (!confirm(`Delete ${label}?`)) return

    try {
      await apiDelete(`/api/projects/${projectId}/emails/${emailId}`)
      setEmails((prev) => prev.filter((e) => e.id !== emailId))
      onExternalFilesChanged?.()
    } catch (e: any) {
      alert(e?.message || 'Failed to delete email')
    }
  }

  const downloadAttachment = async (att: ProjectEmailAttachment) => {
    try {
      const res = await apiFetch(att.downloadUrl)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to download attachment')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = url
      a.download = att.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()

      URL.revokeObjectURL(url)
    } catch (e: any) {
      alert(e?.message || 'Failed to download attachment')
    }
  }

  if (loading && emails.length === 0) {
    return <div className="text-sm text-muted-foreground py-2">Loading emails...</div>
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  return (
    <>
      {emails.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
          No emails imported yet.
        </div>
      ) : (
        <>
          {/* Mobile list */}
          <div className="sm:hidden space-y-2">
            {emails.map((row) => {
              const expanded = expandedMobileId === row.id
              return (
                <div key={row.id} className="border rounded-lg bg-card overflow-hidden">
                  <div
                    className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
                    onClick={() => void openDetail(row.id)}
                    title="Open"
                  >
                    <button
                      type="button"
                      className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded hover:bg-muted"
                      aria-label={expanded ? 'Collapse row' : 'Expand row'}
                      title={expanded ? 'Collapse' : 'Expand'}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setExpandedMobileId((v) => (v === row.id ? null : row.id))
                      }}
                    >
                      {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </button>

                    <div className="min-w-0 flex-1 flex items-start gap-2 rounded px-2 py-1">
                      {row.hasAttachments ? (
                        <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                      ) : (
                        <span className="w-4 h-4 flex-shrink-0" />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{row.subject?.trim() ? row.subject : '(no subject)'}</div>
                        {row.status !== 'READY' && (
                          <div className={`text-xs ${row.status === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {row.status === 'PROCESSING' ? 'Processing…' : row.status === 'UPLOADING' ? 'Uploading…' : row.errorMessage || 'Error'}
                          </div>
                        )}
                      </div>
                    </div>

                    {canDelete && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          void handleDelete(row.id)
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    )}
                  </div>

                  {expanded && (
                    <div className="px-3 pb-3 text-xs text-muted-foreground space-y-1 border-t bg-muted/10">
                      <div className="pt-2">
                        <span className="font-medium text-foreground">From:</span> {displayFrom(row)}
                      </div>
                      <div>
                        <span className="font-medium text-foreground">Date:</span> {formatEmailDate(row.sentAt || row.createdAt)}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-3 py-2 border rounded-lg bg-card">
                <div className="text-xs text-muted-foreground">Page {page} of {totalPages}</div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    Previous
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block rounded-lg border overflow-hidden bg-card">
            <div className="w-full overflow-hidden">
              <table className="w-full text-sm table-fixed">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr className="text-left">
                  {columns.map((col) => (
                    <th key={col.key} className={`px-3 py-2 ${col.className}`}>
                      {col.key === 'attachments' ? (
                        <span className="sr-only">Attachments</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          title="Sort"
                        >
                          <span>{col.label}</span>
                          {sortKey === col.key && (sortDir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />)}
                        </button>
                      )}
                    </th>
                  ))}
                  {canDelete && <th className="py-2 pl-3 pr-4 w-[60px]" aria-label="Delete" />}
                </tr>
              </thead>
              <tbody>
                {emails.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t hover:bg-muted/20 cursor-pointer"
                    onClick={() => void openDetail(row.id)}
                  >
                    <td className="px-3 py-2 text-center">
                      {row.hasAttachments ? <Paperclip className="w-4 h-4 inline-block text-muted-foreground" /> : null}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-full">{row.subject?.trim() ? row.subject : '(no subject)'}</div>
                      {row.status !== 'READY' && (
                        <div className={`text-xs ${row.status === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {row.status === 'PROCESSING' ? 'Processing…' : row.status === 'UPLOADING' ? 'Uploading…' : row.errorMessage || 'Error'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-full">{displayFrom(row)}</td>
                    <td className="px-3 py-2 text-muted-foreground tabular-nums">{formatEmailDate(row.sentAt || row.createdAt)}</td>
                    {canDelete && (
                      <td className="py-2 pl-3 pr-4" onClick={(e) => e.stopPropagation()}>
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleDelete(row.id)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/10">
                <div className="text-xs text-muted-foreground">Page {page} of {totalPages}</div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    Previous
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={detailOpen} onOpenChange={(open) => (open ? setDetailOpen(true) : closeDetail())}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-4xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Imported Email</DialogTitle>
          </DialogHeader>

          {detailLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {detailError && <div className="text-sm text-destructive">{detailError}</div>}

          {!detailLoading && detail && (
            <div className="space-y-4 max-h-[78vh] overflow-auto pr-1">
              <div className="space-y-1">
                <div className="text-base font-semibold break-words">{detail.subject?.trim() ? detail.subject : '(no subject)'}</div>
                <div className="text-sm text-muted-foreground break-words">From: {displayFrom(detail)}</div>
                <div className="text-sm text-muted-foreground">Date: {formatEmailDate(detail.sentAt || detail.createdAt)}</div>
              </div>

              {detail.status !== 'READY' && (
                <div className={`text-sm ${detail.status === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {detail.status === 'PROCESSING' ? 'Processing…' : detail.status === 'UPLOADING' ? 'Uploading…' : detail.errorMessage || 'Error'}
                </div>
              )}

              <div className="border rounded-lg bg-white">
                <div className="max-h-[55vh] overflow-auto p-4 prose prose-sm max-w-none text-black">
                  {detail.htmlBody ? (
                    <div dangerouslySetInnerHTML={{ __html: detail.htmlBody }} />
                  ) : detail.textBody ? (
                    <pre className="whitespace-pre-wrap font-sans text-sm">{detail.textBody}</pre>
                  ) : (
                    <div className="text-sm text-muted-foreground">No email body.</div>
                  )}
                </div>
              </div>

              {detail.attachments.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Attachments</div>
                  <div className="space-y-2">
                    {detail.attachments.map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-3 border rounded-lg bg-card px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{a.fileName}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {formatFileSize(Number(a.fileSize))}{a.isInline ? ' • inline' : ''}
                          </div>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => void downloadAttachment(a)}>
                          <Download className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
