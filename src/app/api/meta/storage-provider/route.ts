/**
 * GET /api/meta/storage-provider
 *
 * Returns the active storage provider at runtime so client-side code can
 * branch between TUS (local/Dropbox) and browser-direct S3 multipart uploads.
 *
 * This endpoint exists because NEXT_PUBLIC_* variables are baked into the JS
 * bundle at build time.  Pre-built Docker images cannot reflect a user's
 * STORAGE_PROVIDER choice at runtime, so the client must ask the server.
 *
 * No auth required — the provider type is not sensitive information.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const raw = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase()
  const provider: 'local' | 's3' | 'dropbox' = raw === 's3' ? 's3' : raw === 'dropbox' ? 'dropbox' : 'local'

  const response = NextResponse.json({ provider })
  // Cache for up to 5 minutes — the value never changes while the container is
  // running, but we don't want to hammer the server on every page load.
  response.headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
  return response
}
