'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import { formatDateTime } from '@/lib/utils'
import { cn } from '@/lib/utils'

interface GuestLinkAuthProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Admin session: authenticate with the admin bearer token instead of the share token. */
  isAdminView?: boolean
  shareToken?: string | null
}

interface GuestVideoLinkDialogProps extends GuestLinkAuthProps {
  projectId: string | null | undefined
  /** The video version the view-only link is for. */
  videoId: string | null | undefined
}

interface GuestAlbumLinkDialogProps extends GuestLinkAuthProps {
  albumId: string | null | undefined
}

/**
 * "Share Video" dialog: shows, creates, copies and re-extends the view-only guest link
 * (/gv/…) for one video version. Used by the comment panel header and the share page's
 * files view.
 */
export function GuestVideoLinkDialog({ projectId, videoId, ...rest }: GuestVideoLinkDialogProps) {
  return (
    <GuestLinkDialog
      {...rest}
      endpoint="/api/guest-video-links"
      ids={projectId && videoId ? { projectId, videoId } : null}
      copy={{
        title: 'Share Video',
        description: 'View-only link for the currently selected video version. The viewer cannot access other videos, see or leave comments, approve videos or download videos.',
        heading: 'Video-only link (expires in 14 days)',
        noun: 'Video Link',
      }}
    />
  )
}

/**
 * "Share Album" dialog: the album counterpart of GuestVideoLinkDialog (/ga/… links). Album
 * guest links allow downloads; they never expose other albums, videos or comments.
 */
export function GuestAlbumLinkDialog({ albumId, ...rest }: GuestAlbumLinkDialogProps) {
  return (
    <GuestLinkDialog
      {...rest}
      endpoint="/api/guest-album-links"
      ids={albumId ? { albumId } : null}
      copy={{
        title: 'Share Album',
        description: 'Guest link for this album. The viewer can browse and download its photos, but cannot see other albums, videos or comments.',
        heading: 'Album-only link (expires in 14 days)',
        noun: 'Album Link',
      }}
    />
  )
}

interface GuestLinkDialogProps extends GuestLinkAuthProps {
  endpoint: '/api/guest-video-links' | '/api/guest-album-links'
  /** Identifies the shared item; sent as query params (GET) and in the POST body. Null = nothing selected. */
  ids: Record<string, string> | null
  copy: { title: string; description: string; heading: string; noun: string }
}

function GuestLinkDialog({
  open,
  onOpenChange,
  isAdminView = false,
  shareToken,
  endpoint,
  ids,
  copy: text,
}: GuestLinkDialogProps) {
  // Stable string key so effects/callbacks don't re-run on every parent render.
  const idsKey = ids ? new URLSearchParams(ids).toString() : ''
  const [generating, setGenerating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [checkedExisting, setCheckedExisting] = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (!expiresAt) {
      setExpired(false)
      return
    }
    const expiresAtMs = new Date(expiresAt).getTime()
    setExpired(Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now())
  }, [expiresAt])

  const authedFetch = useCallback((input: string, init?: RequestInit) => (
    isAdminView
      ? apiFetch(input, init)
      : fetch(input, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
          },
        })
  ), [isAdminView, shareToken])

  const postLink = async (action: 'generate' | 'refreshExpiry') => {
    const response = await authedFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...Object.fromEntries(new URLSearchParams(idsKey)) }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(String((data as any)?.error || 'Failed to update link'))
    }

    const urlPath = String((data as any)?.urlPath || '')
    if (!urlPath) throw new Error('Failed to update link')

    setUrl(new URL(urlPath, window.location.origin).toString())
    setExpiresAt((data as any)?.expiresAt ? String((data as any).expiresAt) : null)
  }

  const generate = async () => {
    if (!idsKey) return
    setGenerating(true)
    setError(null)
    setCopied(false)
    try {
      await postLink('generate')
    } catch (e: any) {
      setError(e?.message || 'Failed to generate link')
    } finally {
      setGenerating(false)
    }
  }

  const refreshExpiry = async () => {
    if (!idsKey || !url) return
    setRefreshing(true)
    setError(null)
    setCopied(false)
    try {
      await postLink('refreshExpiry')
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh expiry')
    } finally {
      setRefreshing(false)
    }
  }

  const loadExisting = useCallback(async () => {
    if (!idsKey) return

    setLoadingExisting(true)
    setUrl(null)
    setExpiresAt(null)
    setError(null)
    setCopied(false)
    setCheckedExisting(false)
    setMissing(false)
    try {
      const response = await authedFetch(`${endpoint}?${idsKey}`, { cache: 'no-store' })

      // 404 = no link for this item yet; any other failure is treated the same way so
      // the viewer can still generate one.
      if (!response.ok) {
        setCheckedExisting(true)
        setMissing(true)
        return
      }

      const data = await response.json().catch(() => ({}))
      const urlPath = String((data as any)?.urlPath || '')
      if (!urlPath) return

      setUrl(new URL(urlPath, window.location.origin).toString())
      setExpiresAt((data as any)?.expiresAt ? String((data as any).expiresAt) : null)
      setCheckedExisting(true)
      setMissing(false)
    } finally {
      setLoadingExisting(false)
    }
  }, [endpoint, idsKey, authedFetch])

  useEffect(() => {
    if (!open) return
    void loadExisting()
  }, [open, loadExisting])

  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          <div className={cn(
            'rounded-md border p-3',
            expired ? 'border-destructive/60 bg-destructive/5' : 'border-border bg-muted/30'
          )}>
            <div className="text-sm font-medium text-foreground">{text.heading}</div>

            {expired ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-3 text-destructive">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <div className="font-semibold">This link has expired</div>
                  <div className="mt-0.5">Viewers can no longer open it. Use Refresh Expiry to reactivate it for another 14 days.</div>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-2">
              {!url && checkedExisting && missing ? (
                <Button type="button" variant="default" onClick={generate} disabled={generating || !idsKey}>
                  {generating ? 'Generating…' : `Generate ${text.noun}`}
                </Button>
              ) : null}

              {url ? (
                <>
                  <Button type="button" variant="outline" onClick={copy}>
                    {copied ? `Copied ${text.noun}` : `Copy ${text.noun}`}
                  </Button>
                  <Button
                    type="button"
                    variant={expired ? 'default' : 'outline'}
                    onClick={refreshExpiry}
                    disabled={refreshing}
                  >
                    {refreshing ? 'Refreshing…' : 'Refresh Expiry'}
                  </Button>
                </>
              ) : null}
            </div>

            {error ? <div className="mt-2 text-sm text-destructive">{error}</div> : null}

            {url ? (
              <div className="mt-3 rounded-md border border-border bg-background/50 p-3">
                <div className="text-xs text-muted-foreground mb-1">Share URL</div>
                <div className="text-sm break-all font-mono">{url}</div>
                {expiresAt ? (
                  expired ? (
                    <div className="mt-2 text-xs font-semibold text-destructive">Expired: {formatDateTime(expiresAt)}</div>
                  ) : (
                    <div className="mt-2 text-xs text-muted-foreground">Expires: {formatDateTime(expiresAt)}</div>
                  )
                ) : null}
              </div>
            ) : null}

            {!url && loadingExisting ? (
              <div className="mt-3 text-xs text-muted-foreground">Loading existing link…</div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
