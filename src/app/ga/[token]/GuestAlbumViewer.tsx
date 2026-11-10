'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShareAlbumViewer } from '@/components/ShareAlbumViewer'
import { formatDateTime } from '@/lib/utils'

type Status = 'loading' | 'ready' | 'expired' | 'notfound' | 'error'

/**
 * Public guest album page (/ga/<token>): one album, browse + download, nothing else.
 * The album payload is loaded once by ShareAlbumViewer (guest mode); this wrapper only adds
 * branding, the expiry line and the unavailable/expired states.
 */
export function GuestAlbumViewer({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>('loading')
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [hasLogo, setHasLogo] = useState(false)
  const [mainCompanyDomain, setMainCompanyDomain] = useState<string | null>(null)
  const logoSrc = '/api/branding/logo'

  const handleLoadResult = useCallback((httpStatus: number, data: any | null) => {
    if (httpStatus >= 200 && httpStatus < 300) {
      setExpiresAt(data?.expiresAt ? String(data.expiresAt) : null)
      setStatus('ready')
    } else if (httpStatus === 410) {
      setStatus('expired')
    } else if (httpStatus === 404) {
      setStatus('notfound')
    } else {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    fetch('/api/branding/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setHasLogo(d.hasLogo || false)
          setMainCompanyDomain(d.mainCompanyDomain || null)
        }
      })
      .catch(() => {})
  }, [])

  if (status === 'expired' || status === 'notfound' || status === 'error') {
    const title =
      status === 'expired'
        ? 'This link has expired'
        : status === 'notfound'
          ? 'This link is not available'
          : 'Unable to load this link'
    const subtitle =
      status === 'expired'
        ? 'Please request a new link from the project share page.'
        : status === 'notfound'
          ? 'It may have been disabled, closed, or is invalid.'
          : 'Please try again in a moment.'

    return (
      <div className="min-h-dvh flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-lg border border-border bg-card p-6">
          <div className="text-lg font-semibold text-card-foreground">{title}</div>
          <div className="mt-2 text-sm text-muted-foreground">{subtitle}</div>
        </div>
      </div>
    )
  }

  const logo = (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logoSrc} alt="Company logo" className="max-w-[150px] max-h-10 w-auto h-auto object-contain" />
  )

  return (
    <div className="h-dvh flex flex-col">
      <div className="border-b border-border bg-background shrink-0">
        <div className="mx-auto w-full max-w-7xl px-4 py-3 flex items-center gap-4">
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">Shared photo album</div>
            <div className="text-xs text-muted-foreground">
              {status === 'loading'
                ? 'Loading…'
                : expiresAt
                  ? `This link expires: ${formatDateTime(expiresAt)}.`
                  : 'This is a guest link.'}
            </div>
          </div>
          {hasLogo ? (
            <div className="shrink-0">
              {mainCompanyDomain ? (
                <a href={mainCompanyDomain} target="_blank" rel="noopener noreferrer">{logo}</a>
              ) : logo}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 mx-auto w-full max-w-7xl px-4 py-4 flex flex-col">
        <ShareAlbumViewer guestToken={token} onLoadResult={handleLoadResult} />
      </div>
    </div>
  )
}
