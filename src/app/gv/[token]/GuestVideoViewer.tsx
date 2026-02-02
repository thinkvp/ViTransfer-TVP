'use client'

import { useEffect, useState } from 'react'
import VideoPlayer from '@/components/VideoPlayer'
import { cn } from '@/lib/utils'

type ResolvePayload = {
  expiresAt: string
  project: {
    id: string
    title: string
    status: any
    watermarkEnabled?: boolean
    timelinePreviewsEnabled?: boolean
  }
  video: {
    id: string
    name?: string | null
    version?: number | null
    versionLabel?: string | null
    approved?: boolean
    streamUrl720p?: string
    streamUrl1080p?: string
    thumbnailUrl?: string | null
    timelineVttUrl?: string | null
    timelineSpriteUrl?: string | null
    timelinePreviewsReady?: boolean
    downloadUrl?: string | null
  }
}

function formatExpiry(expiresAtIso: string): { when: string; isExpired: boolean } {
  const date = new Date(expiresAtIso)
  const isValid = Number.isFinite(date.getTime())
  if (!isValid) return { when: 'Unknown', isExpired: false }

  const isExpired = date.getTime() <= Date.now()
  return {
    when: date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
    isExpired,
  }
}

export function GuestVideoViewer({ token }: { token: string }) {
  const [data, setData] = useState<ResolvePayload | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'expired' | 'notfound' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setStatus('loading')
        const res = await fetch(`/api/guest-video-links/${encodeURIComponent(token)}`, {
          cache: 'no-store',
        })

        if (cancelled) return

        if (res.status === 404) {
          setStatus('notfound')
          setData(null)
          return
        }

        if (res.status === 410) {
          setStatus('expired')
          setData(null)
          return
        }

        if (!res.ok) {
          setStatus('error')
          setData(null)
          return
        }

        const payload = (await res.json()) as ResolvePayload
        setData(payload)
        setStatus('ready')
      } catch {
        if (cancelled) return
        setStatus('error')
        setData(null)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [token])

  const expiry = data?.expiresAt ? formatExpiry(data.expiresAt) : null

  if (status !== 'ready' || !data) {
    const title =
      status === 'expired'
        ? 'This link has expired'
        : status === 'notfound'
          ? 'This link is not available'
          : status === 'error'
            ? 'Unable to load this link'
            : 'Loading…'

    const subtitle =
      status === 'expired'
        ? 'Please request a new link from the project share page.'
        : status === 'notfound'
          ? 'It may have been disabled, closed, or is invalid.'
          : status === 'error'
            ? 'Please try again in a moment.'
            : 'Fetching video…'

    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-lg border border-border bg-card p-6">
          <div className="text-lg font-semibold text-card-foreground">{title}</div>
          <div className="mt-2 text-sm text-muted-foreground">{subtitle}</div>
        </div>
      </div>
    )
  }

  const videoForPlayer = {
    id: data.video.id,
    name: data.video.name,
    version: data.video.version,
    versionLabel: data.video.versionLabel,
    approved: data.video.approved,
    streamUrl720p: data.video.streamUrl720p,
    streamUrl1080p: data.video.streamUrl1080p,
    thumbnailUrl: data.video.thumbnailUrl,
    timelineVttUrl: data.video.timelineVttUrl,
    timelineSpriteUrl: data.video.timelineSpriteUrl,
    timelinePreviewsReady: data.video.timelinePreviewsReady,
    downloadUrl: null,
  }

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <div className="border-b border-border bg-background">
        <div className={cn('mx-auto w-full max-w-6xl px-4 py-3 flex flex-col gap-1')}>
          <div className="text-sm font-medium text-foreground">
            {data.video.name ? data.video.name : 'Video'}
            {data.video.versionLabel ? (
              <span className="text-muted-foreground"> · {data.video.versionLabel}</span>
            ) : null}
          </div>

          <div className="text-xs text-muted-foreground">
            This is a view-only link (no comments, approvals, or access to other videos).
            {expiry?.when ? <span className="ml-1">Expires: {expiry.when}.</span> : null}
          </div>
        </div>
      </div>

      <div className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-4">
          <VideoPlayer
            videos={[videoForPlayer as any]}
            projectId={data.project.id}
            projectStatus={data.project.status}
            watermarkEnabled={data.project.watermarkEnabled ?? true}
            isAdmin={false}
            isGuest={true}
            hideDownloadButton={true}
            commentsForTimeline={[]}
            disableCommentsUI={true}
            fitToContainerHeight={false}
          />
        </div>
      </div>
    </div>
  )
}
