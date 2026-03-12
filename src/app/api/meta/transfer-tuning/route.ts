import { NextResponse } from 'next/server'
import { getTransferTuningSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const tuning = await getTransferTuningSettings()

  const response = NextResponse.json({
    uploadChunkSizeMB: tuning.uploadChunkSizeMB,
    downloadChunkSizeMB: tuning.downloadChunkSizeMB,
  })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}