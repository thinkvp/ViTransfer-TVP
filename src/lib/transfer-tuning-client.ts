'use client'

import { useEffect, useState } from 'react'
import {
  BYTES_PER_MB,
  DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
  DEFAULT_UPLOAD_CHUNK_SIZE_MB,
  normalizeDownloadChunkSizeMB,
  normalizeUploadChunkSizeMB,
} from '@/lib/transfer-tuning'

type TransferTuning = {
  uploadChunkSizeMB: number
  uploadChunkSizeBytes: number
  downloadChunkSizeMB: number
  downloadChunkSizeBytes: number
}

const DEFAULT_TUNING: TransferTuning = {
  uploadChunkSizeMB: DEFAULT_UPLOAD_CHUNK_SIZE_MB,
  uploadChunkSizeBytes: DEFAULT_UPLOAD_CHUNK_SIZE_MB * BYTES_PER_MB,
  downloadChunkSizeMB: DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
  downloadChunkSizeBytes: DEFAULT_DOWNLOAD_CHUNK_SIZE_MB * BYTES_PER_MB,
}

let cachedTuning: TransferTuning | null = null
let tuningRequest: Promise<TransferTuning> | null = null

function normalizeClientPayload(payload: any): TransferTuning {
  const uploadChunkSizeMB = normalizeUploadChunkSizeMB(payload?.uploadChunkSizeMB)
  const downloadChunkSizeMB = normalizeDownloadChunkSizeMB(payload?.downloadChunkSizeMB)

  return {
    uploadChunkSizeMB,
    uploadChunkSizeBytes: uploadChunkSizeMB * BYTES_PER_MB,
    downloadChunkSizeMB,
    downloadChunkSizeBytes: downloadChunkSizeMB * BYTES_PER_MB,
  }
}

async function fetchTransferTuning(): Promise<TransferTuning> {
  if (cachedTuning) return cachedTuning

  if (!tuningRequest) {
    tuningRequest = fetch('/api/meta/transfer-tuning', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load transfer tuning (${response.status})`)
        }
        return normalizeClientPayload(await response.json())
      })
      .catch(() => DEFAULT_TUNING)
      .then((value) => {
        cachedTuning = value
        return value
      })
      .finally(() => {
        tuningRequest = null
      })
  }

  return tuningRequest
}

export function useTransferTuning(): TransferTuning {
  const [tuning, setTuning] = useState<TransferTuning>(cachedTuning || DEFAULT_TUNING)

  useEffect(() => {
    let active = true

    void fetchTransferTuning().then((value) => {
      if (active) setTuning(value)
    })

    return () => {
      active = false
    }
  }, [])

  return tuning
}