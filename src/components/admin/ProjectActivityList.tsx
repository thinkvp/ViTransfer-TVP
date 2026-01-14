'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatDateTime } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'

function getAccessMethodColor(_method: string): string {
  return 'bg-primary-visible text-primary border-2 border-primary-visible'
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0',
        projectStatusBadgeClass(status)
      )}
    >
      {projectStatusLabel(status)}
    </span>
  )
}

export default function ProjectActivityList({
  activity,
  pageSize = 10,
  title,
  description,
}: {
  activity: any[]
  pageSize?: number
  title?: string
  description?: string
}) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  useEffect(() => {
    setPage(1)
  }, [pageSize, activity?.length])

  const totalPages = useMemo(() => {
    const size = Math.max(1, pageSize)
    return Math.max(1, Math.ceil((activity?.length ?? 0) / size))
  }, [activity?.length, pageSize])

  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages))
  }, [totalPages])

  const visible = useMemo(() => {
    const size = Math.max(1, pageSize)
    const start = (page - 1) * size
    const end = start + size
    return (Array.isArray(activity) ? activity : []).slice(start, end)
  }, [activity, page, pageSize])

  const toggleExpand = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  return (
    <div>
      {(title || description) && (
        <div className="mb-3">
          {title && <div className="text-sm font-medium">{title}</div>}
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
      )}

      {Array.isArray(activity) && activity.length > 0 ? (
        <>
          <div className="space-y-2">
            {visible.map((event: any) => {
              const isExpanded = expandedItems.has(String(event.id))
              const eventType = String(event.type || '')
              const accessMethod = String(event.accessMethod || '')

              return (
                <div
                  key={String(event.id)}
                  className="rounded-lg border text-sm hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => toggleExpand(String(event.id))}
                >
                  <div className="flex items-center gap-3 p-3">
                    {eventType === 'STATUS_CHANGE' ? (
                      <StatusPill status={String(event.currentStatus || '')} />
                    ) : (
                      <span
                        className={
                          `px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 ` +
                          (eventType === 'AUTH'
                            ? getAccessMethodColor(accessMethod)
                            : eventType === 'EMAIL' || eventType === 'EMAIL_OPEN'
                              ? 'bg-warning-visible text-warning border-2 border-warning-visible'
                              : 'bg-success-visible text-success border-2 border-success-visible')
                        }
                      >
                        {eventType === 'AUTH' ? (
                          accessMethod === 'OTP'
                            ? 'Email OTP'
                            : accessMethod === 'PASSWORD'
                              ? 'Password'
                              : accessMethod === 'GUEST'
                                ? 'Guest Access'
                                : 'Public Access'
                        ) : eventType === 'EMAIL' ? (
                          <>
                            <Mail className="w-3 h-3 inline mr-1" />
                            Email Sent
                          </>
                        ) : eventType === 'EMAIL_OPEN' ? (
                          <>
                            <Mail className="w-3 h-3 inline mr-1" />
                            Email Opened
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3 inline mr-1" />
                            {event.assetIds ? 'ZIP' : event.assetId ? 'Asset' : 'Video'}
                          </>
                        )}
                      </span>
                    )}

                    <div className="flex-1 min-w-0 flex items-center justify-center">
                      <span className="text-muted-foreground text-sm truncate">
                        {eventType === 'AUTH' ? (
                          event.email
                            ? isExpanded
                              ? String(event.email)
                              : `${String(event.email).substring(0, 20)}${String(event.email).length > 20 ? '...' : ''}`
                            : accessMethod === 'GUEST'
                              ? 'Guest visitor'
                              : 'Public visitor'
                        ) : eventType === 'EMAIL' ? (
                          String(event.description || 'Email sent')
                        ) : eventType === 'EMAIL_OPEN' ? (
                          String(event.description || 'Email opened')
                        ) : eventType === 'STATUS_CHANGE' ? (
                          'Status Changed'
                        ) : (
                          isExpanded
                            ? String(event.videoName || '')
                            : `${String(event.videoName || '').substring(0, 25)}${String(event.videoName || '').length > 25 ? '...' : ''}`
                        )}
                      </span>
                    </div>

                    <div className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                      {formatDateTime(event.createdAt)}
                    </div>

                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-4 pt-3 border-t bg-muted/30">
                      {eventType === 'AUTH' ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                            <span className="text-sm text-muted-foreground">Accessed the project</span>
                          </div>
                          {event.email && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                              <span className="text-sm text-muted-foreground break-all">{String(event.email)}</span>
                            </div>
                          )}
                        </div>
                      ) : eventType === 'EMAIL' ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                            <span className="text-sm text-muted-foreground">{String(event.description || 'Email sent')}</span>
                          </div>
                          {event.videoName && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                              <span className="text-sm text-muted-foreground">
                                {String(event.videoName)}{event.versionLabel ? ` (${String(event.versionLabel)})` : ''}
                              </span>
                            </div>
                          )}
                          {Array.isArray(event.recipients) && event.recipients.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                              <div className="flex-1 space-y-1">
                                {event.recipients.map((email: any, idx: number) => (
                                  <div key={idx} className="text-sm text-muted-foreground break-all">
                                    {String(email)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : eventType === 'EMAIL_OPEN' ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                            <span className="text-sm text-muted-foreground">{String(event.description || 'Email opened')}</span>
                          </div>
                          {event.videoName && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                              <span className="text-sm text-muted-foreground">
                                {String(event.videoName)}{event.versionLabel ? ` (${String(event.versionLabel)})` : ''}
                              </span>
                            </div>
                          )}
                          {event.recipientEmail && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                              <span className="text-sm text-muted-foreground break-all">{String(event.recipientEmail)}</span>
                            </div>
                          )}
                        </div>
                      ) : eventType === 'STATUS_CHANGE' ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                            <span className="text-sm text-muted-foreground">
                              Project changed from{' '}
                              <span className="font-medium">{projectStatusLabel(String(event.previousStatus || ''))}</span>
                              {' '}to{' '}
                              <span className="font-medium">{projectStatusLabel(String(event.currentStatus || ''))}</span>
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                            <span className="text-sm text-muted-foreground">
                              {String(event.videoName || '')}{event.versionLabel ? ` (${String(event.versionLabel)})` : ''}
                            </span>
                          </div>

                          <div className="flex items-start gap-2">
                            <span className="text-xs font-semibold text-foreground min-w-[80px]">Content</span>
                            <div className="flex-1">
                              {Array.isArray(event.assetFileNames) && event.assetFileNames.length > 0 ? (
                                <div>
                                  <p className="text-sm text-muted-foreground mb-2">
                                    ZIP archive with {event.assetFileNames.length} asset{event.assetFileNames.length !== 1 ? 's' : ''}
                                  </p>
                                  <div className="space-y-1 pl-3 border-l-2 border-border">
                                    {event.assetFileNames.map((fileName: any, idx: number) => (
                                      <div key={idx} className="text-sm text-muted-foreground break-all font-mono text-xs">
                                        {String(fileName)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : event.assetFileName ? (
                                <div className="text-sm text-muted-foreground">
                                  <p className="mb-1">Single asset file</p>
                                  <p className="font-mono text-xs break-all pl-3 border-l-2 border-border">
                                    {String(event.assetFileName)}
                                  </p>
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">Full video file</span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 mt-3">
              <p className="text-xs text-muted-foreground tabular-nums">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                  Previous
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-center text-muted-foreground py-8">No activity yet</p>
      )}
    </div>
  )
}
