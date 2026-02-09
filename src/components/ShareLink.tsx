'use client'

import { Button } from './ui/button'
import { Copy } from 'lucide-react'

interface ShareLinkProps {
  shareUrl: string
  label?: string
  disabled?: boolean
}

export default function ShareLink({ shareUrl, label = 'Share Link', disabled = false }: ShareLinkProps) {
  const handleCopy = () => {
    if (disabled) return
    navigator.clipboard.writeText(shareUrl)
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-2">{label}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={shareUrl}
          className={
            `flex-1 min-w-0 px-3 py-2 border rounded-md text-xs sm:text-sm bg-muted overflow-x-auto whitespace-nowrap ${
              disabled ? 'opacity-60' : ''
            }`
          }
        />
        <Button
          onClick={handleCopy}
          variant="outline"
          className="h-9 w-9 sm:w-auto px-0 sm:px-3"
          disabled={disabled}
          aria-label="Copy share link"
        >
          <Copy className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Copy</span>
        </Button>
      </div>
    </div>
  )
}
