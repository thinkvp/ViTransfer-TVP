'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, RefreshCcw, SwitchCamera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const MAX_CAPTURE_DIMENSION = 1800
const JPEG_QUALITY = 0.85

interface CameraCaptureButtonProps {
  onCapture: (files: File[]) => void | Promise<void>
  disabled?: boolean
  className?: string
}

function getCameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return 'Unable to access the camera.'
  if (error.name === 'NotAllowedError') return 'Camera permission was denied.'
  if (error.name === 'NotFoundError') return 'No camera was found on this device.'
  if (error.name === 'NotReadableError') return 'The camera is already in use by another app.'
  return 'Unable to access the camera.'
}

/**
 * After camera permission has been granted, enumerate all video input devices
 * and sort them so the main rear camera comes first (ultrawide, telephoto, and
 * front cameras are pushed to the back).
 */
async function getCameraList(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const cameras = devices.filter(d => d.kind === 'videoinput' && d.deviceId)

  const score = (d: MediaDeviceInfo): number => {
    const lbl = d.label.toLowerCase()
    if (lbl.includes('front') || lbl.includes('user') || lbl.includes('selfie') || lbl.includes('facetime')) return 3
    if (lbl.includes('ultra') || lbl.includes('telephoto') || lbl.includes('macro')) return 2
    if (lbl.includes('wide')) return 1
    return 0 // main / default rear camera scores lowest → sorts first
  }

  return [...cameras].sort((a, b) => score(a) - score(b))
}

export function CameraCaptureButton({ onCapture, disabled = false, className }: CameraCaptureButtonProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraIdx, setCameraIdx] = useState(0)

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const clearCaptured = useCallback(() => {
    setCapturedFile(null)
    setPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }, [])

  const startCamera = useCallback(async (deviceId?: string) => {
    if (!open) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support direct camera capture.')
      return
    }

    setError('')
    setStarting(true)
    stopStream()

    try {
      const videoConstraints: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }

      // After permission is granted labels become available — enumerate and sort cameras
      const list = await getCameraList()
      if (list.length > 0) {
        setCameras(list)
        if (!deviceId) {
          // Identify which camera we actually got and pin the index so the toggle is correct
          const activeSetting = stream.getVideoTracks()[0]?.getSettings().deviceId
          const idx = activeSetting ? list.findIndex(c => c.deviceId === activeSetting) : -1
          setCameraIdx(idx >= 0 ? idx : 0)
        }
      }
    } catch (cameraError) {
      setError(getCameraErrorMessage(cameraError))
    } finally {
      setStarting(false)
    }
  }, [open, stopStream])

  useEffect(() => {
    if (!open || capturedFile) return
    // On first open use the sorted camera list if already populated, otherwise let
    // startCamera select by facingMode (which also populates the list).
    void startCamera(cameras.length > 0 ? cameras[cameraIdx]?.deviceId : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, capturedFile])

  useEffect(() => {
    return () => {
      stopStream()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl, stopStream])

  async function handleSwitchCamera() {
    if (cameras.length < 2 || starting || capturing) return
    const nextIdx = (cameraIdx + 1) % cameras.length
    setCameraIdx(nextIdx)
    await startCamera(cameras[nextIdx].deviceId)
  }

  async function handleCapture() {
    const video = videoRef.current
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setError('Camera is not ready yet.')
      return
    }

    setError('')
    setCapturing(true)
    try {
      const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(video.videoWidth, video.videoHeight))
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        setError('Unable to process the captured image.')
        return
      }

      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
      if (!blob) {
        setError('Unable to capture a photo.')
        return
      }

      stopStream()
      clearCaptured()

      const nextFile = new File([blob], `receipt-${Date.now()}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      })

      setCapturedFile(nextFile)
      setPreviewUrl(URL.createObjectURL(nextFile))
    } finally {
      setCapturing(false)
    }
  }

  async function handleUsePhoto() {
    if (!capturedFile) return
    setError('')
    setSubmitting(true)
    try {
      await onCapture([capturedFile])
      stopStream()
      clearCaptured()
      setOpen(false)
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Unable to attach the photo.')
    } finally {
      setSubmitting(false)
    }
  }

  function handleRetake() {
    clearCaptured()
    void startCamera(cameras.length > 0 ? cameras[cameraIdx]?.deviceId : undefined)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      stopStream()
      clearCaptured()
      setError('')
      setStarting(false)
      setCapturing(false)
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={cn('sm:hidden', className)}
        aria-label="Take photo"
        title="Take photo"
      >
        <Camera className="w-4 h-4" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Take Photo</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {capturedFile && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- previewUrl is a local blob URL; Next.js Image cannot optimize blob URLs
              <img src={previewUrl} alt="Captured receipt preview" className="w-full rounded-md border border-border object-contain" />
            ) : (
              <div className="overflow-hidden rounded-md border border-border bg-black/90">
                <video ref={videoRef} autoPlay muted playsInline className="aspect-[3/4] w-full object-cover" />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {/* Camera toggle — lower-left, shown whenever live view is active and multiple cameras exist */}
                {!capturedFile && cameras.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void handleSwitchCamera()}
                    disabled={starting || capturing}
                    aria-label="Switch camera"
                    title="Switch camera"
                  >
                    <SwitchCamera className="w-4 h-4" />
                  </Button>
                )}
                {!capturedFile && error && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void startCamera(cameras.length > 0 ? cameras[cameraIdx]?.deviceId : undefined)}
                    disabled={starting}
                    aria-label="Retry camera"
                    title="Retry camera"
                  >
                    {starting
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <RefreshCcw className="w-4 h-4" />}
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={capturing || submitting}>
                  Cancel
                </Button>
                {capturedFile ? (
                  <>
                    <Button type="button" variant="outline" onClick={handleRetake} disabled={submitting}>
                      Retake
                    </Button>
                    <Button type="button" onClick={() => void handleUsePhoto()} disabled={submitting}>
                      {submitting ? <><Loader2 className="w-4 h-4 animate-spin" />Attaching…</> : 'Use Photo'}
                    </Button>
                  </>
                ) : (
                  <Button type="button" onClick={() => void handleCapture()} disabled={starting || capturing || !!error && !streamRef.current}>
                    {starting || capturing ? <><Loader2 className="w-4 h-4 animate-spin" />Starting…</> : 'Capture'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>

  )
}