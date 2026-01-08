'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, Pause, Play, X } from 'lucide-react'
import * as tus from 'tus-js-client'
import { apiDelete, apiPost } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { formatFileSize } from '@/lib/utils'
import { validateAssetExtension } from '@/lib/asset-validation'

interface ClientFileUploadProps {
  clientId: string
  onUploadComplete?: () => void
}

export function ClientFileUpload({ clientId, onUploadComplete }: ClientFileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<tus.Upload | null>(null)
  const clientFileIdRef = useRef<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploadSpeed, setUploadSpeed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  function validateFile(f: File): { valid: boolean; error?: string } {
    if (f.size === 0) return { valid: false, error: 'File is empty' }
    return validateAssetExtension(f.name, '')
  }

  async function handleUpload() {
    if (!file) return

    const validation = validateFile(file)
    if (!validation.valid) {
      setError(validation.error || 'Invalid file type')
      return
    }

    setUploading(true)
    setError(null)
    setProgress(0)
    setPaused(false)

    try {
      const response = await apiPost(`/api/clients/${clientId}/files`, {
        fileName: file.name,
        fileSize: file.size,
      })

      const { clientFileId } = response
      clientFileIdRef.current = clientFileId

      const startTime = Date.now()
      let lastLoaded = 0
      let lastTime = startTime

      const upload = new tus.Upload(file, {
        endpoint: '/api/uploads',
        retryDelays: [0, 1000, 3000, 5000, 10000],
        metadata: {
          filename: file.name,
          filetype: file.type || 'application/octet-stream',
          clientFileId,
        },
        chunkSize: 50 * 1024 * 1024,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,

        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100)
          setProgress(percentage)

          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000
          const bytesDiff = bytesUploaded - lastLoaded

          if (timeDiff > 0.5) {
            const speedMBps = (bytesDiff / timeDiff) / (1024 * 1024)
            setUploadSpeed(Math.round(speedMBps * 10) / 10)
            lastLoaded = bytesUploaded
            lastTime = now
          }
        },

        onSuccess: () => {
          setUploading(false)
          setProgress(100)
          setFile(null)
          uploadRef.current = null
          clientFileIdRef.current = null
          if (fileInputRef.current) fileInputRef.current.value = ''
          onUploadComplete?.()
        },

        onError: async (err) => {
          let errorMessage = 'Upload failed'
          if (err.message?.includes('NetworkError') || err.message?.includes('Failed to fetch')) {
            errorMessage = 'Network error. Please check your connection and try again.'
          } else if (err.message?.includes('413')) {
            errorMessage = 'File is too large. Please choose a smaller file.'
          } else if (err.message?.includes('401') || err.message?.includes('403')) {
            errorMessage = 'Authentication failed. Please log in again.'
          } else if (err.message) {
            errorMessage = err.message
          }

          // Clean up DB record on error
          if (clientFileIdRef.current) {
            try {
              await apiDelete(`/api/clients/${clientId}/files/${clientFileIdRef.current}`)
              clientFileIdRef.current = null
            } catch {}
          }

          setError(errorMessage)
          setUploading(false)
        },

        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject()
          xhr.withCredentials = true
          const token = getAccessToken()
          if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          }
        },
      })

      uploadRef.current = upload
      upload.start()
    } catch (err: any) {
      setError(err?.message || 'Upload failed')
      setUploading(false)
    }
  }

  function handlePauseResume() {
    if (!uploadRef.current) return
    if (paused) {
      uploadRef.current.start()
      setPaused(false)
    } else {
      uploadRef.current.abort()
      setPaused(true)
    }
  }

  async function handleCancel() {
    if (uploadRef.current) {
      uploadRef.current.abort(true)
      uploadRef.current = null
    }

    if (clientFileIdRef.current) {
      try {
        await apiDelete(`/api/clients/${clientId}/files/${clientFileIdRef.current}`)
        clientFileIdRef.current = null
      } catch {}
    }

    setUploading(false)
    setPaused(false)
    setProgress(0)
    setUploadSpeed(0)
    setError(null)
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="client-file">Upload file</Label>
        <Input
          id="client-file"
          ref={fileInputRef}
          type="file"
          disabled={uploading}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <p className="text-xs text-muted-foreground">Allowed types match project video asset uploads.</p>
      </div>

      {file && !uploading && (
        <div className="text-xs text-muted-foreground">Selected: {file.name} ({formatFileSize(file.size)})</div>
      )}

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" onClick={handleUpload} disabled={!file || uploading}>
          <Upload className="w-4 h-4 mr-2" />
          Upload
        </Button>

        {uploading && (
          <>
            <Button type="button" variant="outline" onClick={handlePauseResume}>
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleCancel()}>
              <X className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>

      {uploading && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{progress}%</span>
            <span>{uploadSpeed > 0 ? `${uploadSpeed} MB/s` : ''}</span>
          </div>
          <div className="h-2 w-full bg-muted rounded">
            <div className="h-2 bg-primary rounded" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}
