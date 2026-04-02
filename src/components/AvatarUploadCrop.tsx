'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import { Camera, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AvatarUploadCropProps {
  userId: string
  currentAvatarPath: string | null
  displayName?: string | null
  displayColor?: string | null
  size?: number // display size in px (default 96)
  onAvatarChange?: (newAvatarPath: string | null) => void
}

// ─── Preview circle ─────────────────────────────────────────────────────────
function AvatarPreview({
  src,
  name,
  color,
  size,
  className,
}: {
  src: string | null
  name?: string | null
  color?: string | null
  size: number
  className?: string
}) {
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    setImgError(false)
  }, [src])

  const initials = (() => {
    const n = (name || '').trim()
    const tokens = n.split(/\s+/).filter(Boolean)
    if (tokens.length >= 2) return `${tokens[0][0]}${tokens[tokens.length - 1][0]}`.toUpperCase()
    if (tokens.length === 1) return `${tokens[0][0]}${tokens[0][1] || ''}`.toUpperCase()
    return '--'
  })()

  const bg = typeof color === 'string' && color.trim() ? color : '#64748b'

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={name || 'Avatar'}
        width={size}
        height={size}
        className={cn('rounded-full object-cover', className)}
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div
      className={cn('rounded-full flex items-center justify-center font-semibold uppercase select-none', className)}
      style={{ width: size, height: size, backgroundColor: bg, color: '#fff', fontSize: size * 0.33 }}
    >
      {initials}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export function AvatarUploadCrop({
  userId,
  currentAvatarPath,
  displayName,
  displayColor,
  size = 96,
  onAvatarChange,
}: AvatarUploadCropProps) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Crop state
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const PREVIEW_SIZE = 256 // display canvas size (px)
  const OUTPUT_SIZE = 300  // server output size (px)

  // Build current avatar URL
  const avatarUrl = currentAvatarPath
    ? `/api/users/${userId}/avatar?t=${Date.now()}`
    : null
  const [displayAvatarUrl, setDisplayAvatarUrl] = useState(avatarUrl)
  useEffect(() => {
    setDisplayAvatarUrl(currentAvatarPath ? `/api/users/${userId}/avatar` : null)
  }, [currentAvatarPath, userId])

  // ─── Canvas drawing ──────────────────────────────────────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageSrc) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new window.Image()
    img.onload = () => {
      ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)

      // Compute base cover scale
      const coverScale = Math.max(PREVIEW_SIZE / img.naturalWidth, PREVIEW_SIZE / img.naturalHeight)
      const finalScale = coverScale * scale

      const drawW = img.naturalWidth * finalScale
      const drawH = img.naturalHeight * finalScale

      const x = (PREVIEW_SIZE - drawW) / 2 + offset.x
      const y = (PREVIEW_SIZE - drawH) / 2 + offset.y

      ctx.drawImage(img, x, y, drawW, drawH)

      // Darken outside circle
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.beginPath()
      ctx.arc(PREVIEW_SIZE / 2, PREVIEW_SIZE / 2, PREVIEW_SIZE / 2 - 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // Circle border
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(PREVIEW_SIZE / 2, PREVIEW_SIZE / 2, PREVIEW_SIZE / 2 - 2, 0, Math.PI * 2)
      ctx.stroke()
    }
    img.src = imageSrc
  }, [imageSrc, offset, scale])

  useEffect(() => {
    drawCanvas()
  }, [drawCanvas])

  // ─── File selection ───────────────────────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type)) {
      setError('Only JPEG and PNG files are accepted.')
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      setImageSrc(ev.target?.result as string)
      setOffset({ x: 0, y: 0 })
      setScale(1)
    }
    reader.readAsDataURL(file)
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }

  // ─── Drag handlers ────────────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging || !dragStart.current) return
    const dx = e.clientX - dragStart.current.mx
    const dy = e.clientY - dragStart.current.my
    setOffset({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy })
  }

  function onPointerUp() {
    setDragging(false)
    dragStart.current = null
  }

  // ─── Wheel zoom ───────────────────────────────────────────────────────────
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault()
    setScale((s) => Math.min(4, Math.max(0.5, s - e.deltaY * 0.001)))
  }

  // ─── Export + upload ──────────────────────────────────────────────────────
  async function handleApply() {
    if (!imageSrc) return
    setError(null)
    setSaving(true)

    try {
      // Draw to an offscreen OUTPUT_SIZE×OUTPUT_SIZE canvas
      const offscreen = document.createElement('canvas')
      offscreen.width = OUTPUT_SIZE
      offscreen.height = OUTPUT_SIZE
      const ctx = offscreen.getContext('2d')!

      await new Promise<void>((resolve, reject) => {
        const img = new window.Image()
        img.onload = () => {
          const coverScale = Math.max(PREVIEW_SIZE / img.naturalWidth, PREVIEW_SIZE / img.naturalHeight)
          const finalScale = coverScale * scale

          // Scale offscreen ratio relative to preview
          const ratio = OUTPUT_SIZE / PREVIEW_SIZE
          const drawW = img.naturalWidth * finalScale * ratio
          const drawH = img.naturalHeight * finalScale * ratio
          const x = (OUTPUT_SIZE - drawW) / 2 + offset.x * ratio
          const y = (OUTPUT_SIZE - drawH) / 2 + offset.y * ratio

          ctx.drawImage(img, x, y, drawW, drawH)
          resolve()
        }
        img.onerror = reject
        img.src = imageSrc
      })

      const blob = await new Promise<Blob>((resolve, reject) =>
        offscreen.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))),
          'image/jpeg',
          0.9,
        ),
      )

      const form = new FormData()
      form.append('image', blob, 'avatar.jpg')

      const res = await apiFetch(`/api/users/${userId}/avatar`, {
        method: 'POST',
        body: form,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || 'Upload failed')
      }

      const data = await res.json()
      // Bust the cache so the new image shows
      setDisplayAvatarUrl(`/api/users/${userId}/avatar?t=${Date.now()}`)
      onAvatarChange?.(data.avatarPath)
      setOpen(false)
      setImageSrc(null)
    } catch (err: any) {
      setError(err?.message || 'Upload failed')
    } finally {
      setSaving(false)
    }
  }

  // ─── Delete avatar ────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!confirm('Remove this profile picture?')) return
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/users/${userId}/avatar`, { method: 'DELETE' } as RequestInit)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || 'Delete failed')
      }
      setDisplayAvatarUrl(null)
      onAvatarChange?.(null)
    } catch (err: any) {
      setError(err?.message || 'Delete failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      {/* Current avatar */}
      <div className="relative flex-shrink-0">
        <AvatarPreview
          src={displayAvatarUrl}
          name={displayName}
          color={displayColor}
          size={size}
          className="ring-2 ring-border"
        />
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { setOpen(true); setImageSrc(null); setError(null) }}
            disabled={saving}
          >
            <Camera className="w-3.5 h-3.5 mr-1.5" />
            {displayAvatarUrl ? 'Change photo' : 'Upload photo'}
          </Button>
          {displayAvatarUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={saving}
              title="Remove photo"
            >
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">PNG or JPEG</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {/* Crop dialog */}
      <Dialog open={open} onOpenChange={(v) => { if (!saving) setOpen(v) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Upload Profile Photo</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* File picker */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Choose file…
              </Button>
              <p className="text-xs text-muted-foreground mt-1">JPEG or PNG only</p>
            </div>

            {/* Canvas crop area */}
            {imageSrc ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Drag to reposition · scroll or use slider to zoom
                </p>
                <div className="flex justify-center">
                  <canvas
                    ref={canvasRef}
                    width={PREVIEW_SIZE}
                    height={PREVIEW_SIZE}
                    className="rounded-lg border border-border cursor-grab active:cursor-grabbing"
                    style={{ touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onWheel={onWheel}
                  />
                </div>

                {/* Zoom slider */}
                <div className="flex items-center gap-2">
                  <ZoomOut className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <input
                    type="range"
                    min={50}
                    max={400}
                    step={1}
                    value={Math.round(scale * 100)}
                    onChange={(e) => setScale(Number(e.target.value) / 100)}
                    className="flex-1 accent-primary"
                    aria-label="Zoom"
                  />
                  <ZoomIn className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-32 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                No image selected
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={handleApply}
                disabled={!imageSrc || saving}
              >
                {saving ? 'Saving…' : 'Apply'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
