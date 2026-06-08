'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface VttCue {
  startSeconds: number
  endSeconds: number
  spriteFile: string
  x: number
  y: number
  w: number
  h: number
}

interface VideoHoverPreviewProps {
  /** Fallback static thumbnail URL shown when not hovering or before VTT loads. */
  thumbnailUrl: string
  /** Tokenized URL to the WebVTT index file. */
  vttUrl: string
  /** Tokenized base URL for sprite images — sprite filename is appended. */
  spriteBaseUrl: string
  /** Video duration in seconds (used to map mouse position to time). */
  durationSeconds: number
  /** Alt text for the image. */
  alt: string
  /** Additional CSS classes for the container. */
  className?: string
  /** Optional inline styles for the container (e.g. explicit width/height). */
  style?: React.CSSProperties
}

function parseVttTimestamp(ts: string): number {
  // Format: HH:MM:SS.mmm or MM:SS.mmm
  const parts = ts.trim().split(':')
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const s = parseFloat(parts[2])
    return h * 3600 + m * 60 + s
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10)
    const s = parseFloat(parts[1])
    return m * 60 + s
  }
  return parseFloat(ts) || 0
}

function parseVtt(text: string): VttCue[] {
  const cues: VttCue[] = []
  const lines = text.split(/\r?\n/)

  let i = 0
  // Skip WEBVTT header
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('WEBVTT'))) {
    i++
  }

  while (i < lines.length) {
    // Skip blank lines and note blocks
    while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('NOTE'))) {
      i++
    }
    if (i >= lines.length) break

    const timingLine = lines[i].trim()
    i++

    const timingMatch = timingLine.match(/^(\S+)\s*-->\s*(\S+)/)
    if (!timingMatch) continue

    const startSeconds = parseVttTimestamp(timingMatch[1])
    const endSeconds = parseVttTimestamp(timingMatch[2])

    // Read payload line — it may be empty if no sprite data
    let payloadLine = ''
    while (i < lines.length && lines[i].trim() === '') {
      i++
    }
    if (i < lines.length && !lines[i].includes('-->')) {
      payloadLine = lines[i].trim()
      i++
    }

    // Parse sprite reference: sprite-000.jpg#xywh=x,y,w,h
    const spriteMatch = payloadLine.match(/^(sprite-\d+\.jpg)#xywh=(\d+),(\d+),(\d+),(\d+)/)
    if (spriteMatch) {
      cues.push({
        startSeconds,
        endSeconds,
        spriteFile: spriteMatch[1],
        x: parseInt(spriteMatch[2], 10),
        y: parseInt(spriteMatch[3], 10),
        w: parseInt(spriteMatch[4], 10),
        h: parseInt(spriteMatch[5], 10),
      })
    }
  }

  return cues
}

export default function VideoHoverPreview({
  thumbnailUrl,
  vttUrl,
  spriteBaseUrl,
  durationSeconds,
  alt,
  className,
  style,
}: VideoHoverPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(0)
  const [containerH, setContainerH] = useState(0)
  const [cues, setCues] = useState<VttCue[] | null>(null)
  const [vttError, setVttError] = useState(false)
  const [hoverPercent, setHoverPercent] = useState<number | null>(null)
  const [activeSpriteUrl, setActiveSpriteUrl] = useState<string | null>(null)
  const [activeCue, setActiveCue] = useState<VttCue | null>(null)
  const [thumbnailError, setThumbnailError] = useState(!thumbnailUrl)
  const vttLoadedRef = useRef(false)
  const prevSpriteFileRef = useRef<string | null>(null)

  // Reset thumbnail error if a valid URL arrives later (e.g. after async preview resolution)
  useEffect(() => {
    if (thumbnailUrl) {
      setThumbnailError(false)
    }
  }, [thumbnailUrl])

  // Track container dimensions via ResizeObserver so we don't read refs during render.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        const r = entry.contentRect
        setContainerW(r.width)
        setContainerH(r.height)
      }
    })
    ro.observe(el)
    const rect = el.getBoundingClientRect()
    setContainerW(rect.width)
    setContainerH(rect.height)
    return () => ro.disconnect()
  }, [])

  // Load VTT on first hover
  const loadVtt = useCallback(async () => {
    if (vttLoadedRef.current || cues !== null || vttError) return
    vttLoadedRef.current = true

    try {
      const res = await fetch(vttUrl)
      if (!res.ok) {
        setVttError(true)
        return
      }
      const text = await res.text()
      const parsed = parseVtt(text)
      if (parsed.length === 0) {
        setVttError(true)
        return
      }
      setCues(parsed)
    } catch {
      setVttError(true)
    }
  }, [vttUrl, cues, vttError])

  const handleMouseEnter = useCallback(() => {
    void loadVtt()
  }, [loadVtt])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = containerRef.current
      if (!el) return

      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percent = Math.max(0, Math.min(1, x / rect.width))
      setHoverPercent(percent)

      // Use the local cues variable captured from the closure — but cues
      // is set via state, so on subsequent renders after VTT loads, this
      // callback will have the updated cues in its closure.
    },
    []
  )

  // Derive sprite position from cues + hoverPercent
  useEffect(() => {
    if (hoverPercent === null || !cues || cues.length === 0 || durationSeconds <= 0) {
      return
    }

    const targetTime = hoverPercent * durationSeconds

    // Binary search for the matching cue
    let lo = 0
    let hi = cues.length - 1
    let match: VttCue | null = null

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const cue = cues[mid]
      if (targetTime < cue.startSeconds) {
        hi = mid - 1
      } else if (targetTime >= cue.endSeconds) {
        lo = mid + 1
      } else {
        match = cue
        break
      }
    }

    // Fallback: closest cue
    if (!match && cues.length > 0) {
      let closest = cues[0]
      let minDist = Math.abs(targetTime - closest.startSeconds)
      for (let i = 1; i < cues.length; i++) {
        const dist = Math.abs(targetTime - cues[i].startSeconds)
        if (dist < minDist) {
          minDist = dist
          closest = cues[i]
        }
      }
      match = closest
    }

    if (match) {
      const url = `${spriteBaseUrl}?file=${encodeURIComponent(match.spriteFile)}`
      if (prevSpriteFileRef.current !== match.spriteFile) {
        prevSpriteFileRef.current = match.spriteFile
        setActiveSpriteUrl(url)
      }
      setActiveCue(match)
    }
  }, [hoverPercent, cues, durationSeconds, spriteBaseUrl])

  const handleMouseLeave = useCallback(() => {
    setHoverPercent(null)
  }, [])

  const showHoverSprite = hoverPercent !== null && activeSpriteUrl && activeCue && !vttError

  // Compute the pixel-perfect frame display size so the sprite tile fits within the
  // container without adjacent-row bleed (contain-fit).  Container dimensions are
  // tracked via ResizeObserver so they stay accurate on resize.
  let spriteDivStyle: React.CSSProperties | null = null
  if (showHoverSprite && activeCue && containerW > 0 && containerH > 0) {
    const col = activeCue.x / activeCue.w
    const row = activeCue.y / activeCue.h
    // Scale the frame to fit within the container (contain)
    const scale = Math.min(containerW / activeCue.w, containerH / activeCue.h)
    const displayW = Math.round(activeCue.w * scale)
    const displayH = Math.round(activeCue.h * scale)
    spriteDivStyle = {
      width: displayW,
      height: displayH,
      backgroundImage: `url(${activeSpriteUrl})`,
      backgroundSize: `${displayW * 10}px ${displayH * 10}px`,
      backgroundPosition: `-${col * displayW}px -${row * displayH}px`,
      backgroundRepeat: 'no-repeat',
      flexShrink: 0,
    }
  }

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-black/85 ${className || ''}`}
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Fallback thumbnail (hidden when sprite is active or on error) */}
      {/* eslint-disable @next/next/no-img-element */}
      {!thumbnailError && (
        <img
          src={thumbnailUrl}
          alt={alt}
          className={`w-full h-full object-contain transition-opacity duration-150 ${
            showHoverSprite ? 'opacity-0' : 'opacity-100'
          }`}
          loading="lazy"
          onError={() => setThumbnailError(true)}
        />
      )}
      {/* eslint-enable @next/next/no-img-element */}
      {thumbnailError && (
        <div className="w-full h-full flex items-center justify-center bg-black/85 text-muted-foreground text-xs">
          Preview unavailable
        </div>
      )}

      {/* Hover sprite — rendered as a pixel-perfect background div sized to fit
           within the container (contain-fit), centered via flexbox.  This prevents
           adjacent sprite rows/columns from bleeding into the black-bar area. */}
      {spriteDivStyle && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div style={spriteDivStyle} />
        </div>
      )}

      {/* Vertical position indicator line */}
      {hoverPercent !== null && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.5)] pointer-events-none z-10"
          style={{ left: `${hoverPercent * 100}%` }}
        />
      )}
    </div>
  )
}
