'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChevronDown, ChevronUp, Cloud, CloudOff } from 'lucide-react'

interface DropboxStorageSectionProps {
  show: boolean
  setShow: (show: boolean) => void
  dropboxConfigured: boolean
  dropboxRootPath: string
}

export function DropboxStorageSection({
  show,
  setShow,
  dropboxConfigured,
  dropboxRootPath,
}: DropboxStorageSectionProps) {
  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {dropboxConfigured ? 'Dropbox Storage' : (
                <>
                  <CloudOff className="w-5 h-5 text-muted-foreground" />
                  Dropbox Storage
                </>
              )}
            </CardTitle>
            <CardDescription>
              {dropboxConfigured
                ? 'Video originals, assets, and album ZIPs can be offloaded to Dropbox'
                : 'All files use local storage'}
            </CardDescription>
          </div>
          {show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>
      {show && (
        <CardContent className="space-y-4 border-t pt-4">
          {dropboxConfigured ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-success-visible text-success border border-success-visible">
                  <Cloud className="w-3 h-3" />
                  Connected
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Each video version has a Dropbox toggle — available when the version is set to <strong>Approvable</strong> — that uploads its original file and any associated assets to Dropbox. Album ZIPs are automatically uploaded to Dropbox when the album has Dropbox enabled. Transcoded preview files remain on the local server for streaming.
              </p>
              {dropboxRootPath && (
                <div className="text-sm">
                  <span className="font-medium">Root Path:</span>{' '}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{dropboxRootPath}</code>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Configured via environment variables (DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
                DROPBOX_REFRESH_TOKEN). Downloads are served via temporary Dropbox direct-download links.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground border border-border">
                  <CloudOff className="w-3 h-3" />
                  Not Configured
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                To enable Dropbox offloading for video originals, assets, and album ZIPs, set <code className="bg-muted px-1 py-0.5 rounded text-xs">DROPBOX_APP_KEY</code>,{' '}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">DROPBOX_APP_SECRET</code>, and{' '}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">DROPBOX_REFRESH_TOKEN</code> in
                your environment variables and restart the application.
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
