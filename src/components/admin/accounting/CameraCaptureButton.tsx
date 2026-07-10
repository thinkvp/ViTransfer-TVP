'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, RefreshCcw, SwitchCamera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const MAX_CAPTURE_DIMENSION = 1800
const JPEG_QUALITY = 0.85

// Labels containing these words are deprioritised when selecting the default camera
const DEPRIORITISED_LENS_LABELS = ['ultra', 'telephoto', 'macro']
// Labels containing these words indicate a front/selfie camera — strongly deprioritised
const FRONT_CAMERA_LABELS = ['front', 'selfie', 'facetime', 'user']

function sortCameraDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const videoDevices = devices.filter(d => d.kind === 'videoinput')
  return [...videoDevices].sort((a, b) => {
    const score = (label: string) => {
      const l = label.toLowerCase()
      if (FRONT_CAMERA_LABELS.some(w => l.includes(w))) return 10
      if (DEPRIORITISED_LENS_LABELS.some(w => l.includes(w))) return 1
      return 0
    }
    return score(a.label) - score(b.label)
  })
}

interface CameraCaptureButtonProps {
  onCapture: (files: File[]) => void | Promise<void>
  disabled?: boolean
  className?: string
}

interface CameraCaptureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCapture: (files: File[]) => void | Promise<void>
}

function getCameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return 'Unable to access the camera.'
  if (error.name === 'NotAllowedError') return 'Camera permission was denied.'
  if (error.name === 'NotFoundError') return 'No camera was found on this device.'
  if (error.name === 'NotReadableError') return 'The camera is already in use by another app.'
  return 'Unable to access the camera.'
}

/** Controlled take-photo dialog — usable from any trigger (accounting buttons, the assistant's plus menu) */
export function CameraCaptureDialog({ open, onOpenChange, onCapture }: CameraCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // camerasRef holds the sorted device list (populated after permission is granted)
  const camerasRef = useRef<MediaDeviceInfo[]>([])
  const cameraIdxRef = useRef(0)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [cameraCount, setCameraCount] = useState(0)
  // Mirrors streamRef so render logic (Capture button disabled state) stays reactive
  const [hasStream, setHasStream] = useState(false)

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setHasStream(false)
  }, [])

  const clearCaptured = useCallback(() => {
    setCapturedFile(null)
    setPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }, [])

  const openStream = useCallback(async (stream: MediaStream) => {
    streamRef.current = stream
    setHasStream(true)
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play().catch(() => undefined)
    }
  }, [])

  const startCameraWithDevice = useCallback(async (deviceId: string | null) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support direct camera capture.')
      return
    }

    setError('')
    setStarting(true)
    stopStream()

    try {
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video })

      // On first open, enumerate devices (labels are available after permission is granted)
      // and switch to the main rear camera if the browser didn't already select it.
      if (camerasRef.current.length === 0) {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        const sorted = sortCameraDevices(allDevices)
        camerasRef.current = sorted
        setCameraCount(sorted.length)

        if (sorted.length > 1) {
          const activeDeviceId = stream.getVideoTracks()[0]?.getSettings()?.deviceId
          const preferredDeviceId = sorted[0]?.deviceId
          if (activeDeviceId && preferredDeviceId && activeDeviceId !== preferredDeviceId) {
            // The browser opened an ultrawide/telephoto — switch to the main camera
            for (const track of stream.getTracks()) track.stop()
            const mainStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: preferredDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            })
            await openStream(mainStream)
            return
          }
        }
      }

      await openStream(stream)
    } catch (cameraError) {
      setError(getCameraErrorMessage(cameraError))
    } finally {
      setStarting(false)
    }
  }, [stopStream, openStream])

  const startCamera = useCallback(async () => {
    if (!open) return
    const cameras = camerasRef.current
    const deviceId = cameras.length > 0 ? (cameras[cameraIdxRef.current]?.deviceId ?? null) : null
    await startCameraWithDevice(deviceId)
  }, [open, startCameraWithDevice])

  const cycleCamera = useCallback(async () => {
    const cameras = camerasRef.current
    if (cameras.length < 2) return
    const nextIdx = (cameraIdxRef.current + 1) % cameras.length
    cameraIdxRef.current = nextIdx
    await startCameraWithDevice(cameras[nextIdx].deviceId)
  }, [startCameraWithDevice])

  useEffect(() => {
    if (!open || capturedFile) return
    void startCamera()
  }, [open, capturedFile, startCamera])

  useEffect(() => {
    return () => {
      stopStream()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl, stopStream])

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
      onOpenChange(false)
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Unable to attach the photo.')
    } finally {
      setSubmitting(false)
    }
  }

  function handleRetake() {
    // Resume on whichever camera was active when the photo was taken
    clearCaptured()
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen)
    if (!nextOpen) {
      stopStream()
      clearCaptured()
      setError('')
      setStarting(false)
      setCapturing(false)
      setSubmitting(false)
      // Reset camera list so next open re-enumerates and picks the main camera
      camerasRef.current = []
      cameraIdxRef.current = 0
      setCameraCount(0)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Take Photo</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {capturedFile && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Captured receipt preview" className="w-full rounded-md border border-border object-contain" />
            ) : (
              <div className="relative overflow-hidden rounded-md border border-border bg-black/90">
                <video ref={videoRef} autoPlay muted playsInline className="aspect-3/4 w-full object-cover" />
                {cameraCount > 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute bottom-2 left-2 opacity-80 hover:opacity-100"
                    onClick={() => void cycleCamera()}
                    disabled={starting}
                    aria-label="Switch camera"
                    title="Switch camera"
                  >
                    <SwitchCamera className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {!capturedFile && error && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void startCamera()}
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
                  <Button type="button" onClick={() => void handleCapture()} disabled={starting || capturing || !!error && !hasStream}>
                    {starting || capturing ? <><Loader2 className="w-4 h-4 animate-spin" />Starting…</> : 'Capture'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
  )
}

/** Mobile-only trigger button wrapping the dialog — the original accounting call sites */
export function CameraCaptureButton({ onCapture, disabled = false, className }: CameraCaptureButtonProps) {
  const [open, setOpen] = useState(false)

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

      <CameraCaptureDialog open={open} onOpenChange={setOpen} onCapture={onCapture} />
    </>
  )
}