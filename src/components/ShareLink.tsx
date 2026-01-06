'use client'

import { Button } from './ui/button'
import { useState } from 'react'

interface ShareLinkProps {
  shareUrl: string
  label?: string
  disabled?: boolean
}

export default function ShareLink({ shareUrl, label = 'Share Link', disabled = false }: ShareLinkProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (disabled) return
    navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-2">{label}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          readOnly
          value={shareUrl}
          className={
            `flex-1 px-3 py-2 border rounded-md text-xs sm:text-sm bg-muted truncate ${disabled ? 'opacity-60' : ''}`
          }
        />
        <Button onClick={handleCopy} variant="outline" className="w-full sm:w-auto" disabled={disabled}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
