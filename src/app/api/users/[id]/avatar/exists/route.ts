import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
// USER_AVATAR has no project association — getStoredFilePathForProject() would return null.
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath } from '@/lib/stored-file'
import { isS3Mode, s3FileExists } from '@/lib/s3-storage'
import { getFilePath } from '@/lib/storage'
import { statSync } from 'fs'

export const runtime = 'nodejs'

// ─── GET /api/users/[id]/avatar/exists ──────────────────────────────────────
// Returns whether a user has a profile avatar. ALWAYS 200 (never 404), so the client can
// decide whether to render the avatar <img> without firing a request that 404s for users on
// default initials. No auth (rate-limited), mirroring the avatar GET endpoint.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 600, message: 'Too many requests.' },
    'user-avatar-exists',
  )
  if (limited) return limited

  const { id } = await params

  let exists = false
  try {
    // Mirror the avatar GET's resolution: StoredFile AVATAR, else the legacy path, then check
    // the object actually exists.
    let avatarPath = await getStoredFilePath('USER_AVATAR', id, 'AVATAR')
    if (!avatarPath) avatarPath = `users/${id}/avatar.jpg`
    if (isS3Mode()) {
      exists = await s3FileExists(avatarPath)
    } else {
      try { statSync(getFilePath(avatarPath)); exists = true } catch { exists = false }
    }
  } catch {
    exists = false
  }

  const res = NextResponse.json({ exists })
  // Safe to cache briefly — avatar existence changes rarely.
  res.headers.set('Cache-Control', 'public, max-age=300')
  return res
}
