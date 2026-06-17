/**
 * Shared API route utilities — body size validation & auth wrappers.
 *
 * - checkBodySize(): reject oversized JSON request bodies (DoS prevention)
 * - requireApiMenuAction(): auth + menu + action check in a single call
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser, type AuthUser } from '@/lib/auth'
import { requireMenuAccess, requireActionAccess } from '@/lib/rbac-api'
import type { MenuKey, ActionKey } from '@/lib/rbac'

// ---------------------------------------------------------------------------
// Body size guard
// ---------------------------------------------------------------------------

/** Maximum JSON body size (10 MB). Tune per-environment if needed. */
const DEFAULT_MAX_BODY_BYTES = 10 * 1_024 * 1_024

/**
 * Reject requests whose Content-Length exceeds the configured max.
 *
 * This is a defense-in-depth DoS guard: without it, an attacker can send a
 * multi-gigabyte JSON payload and exhaust server memory during JSON.parse().
 *
 * Does NOT apply to file-upload / TUS routes which use streaming uploads.
 *
 * @param request   - The incoming NextRequest.
 * @param maxBytes  - Maximum allowed body size in bytes (default 10 MB).
 * @returns null if the body is acceptable, or a 413 Response if too large.
 */
export function checkBodySize(
  request: NextRequest,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Response | null {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return null // No header — let JSON.parse() handle it

  const size = Number(contentLength)
  if (!Number.isFinite(size) || size < 0) {
    return NextResponse.json(
      { error: 'Invalid Content-Length header' },
      { status: 400 },
    )
  }

  if (size > maxBytes) {
    return NextResponse.json(
      { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' },
      { status: 413 },
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Combined auth wrapper
// ---------------------------------------------------------------------------

/**
 * Authenticate the request AND enforce both menu visibility + action permission
 * in a single call. Eliminates the repeated 3-block auth boilerplate present in
 * most admin API routes.
 *
 * Usage:
 *   const { user, error } = await requireApiMenuAction(request, 'projects', 'uploadVideosOnProjects')
 *   if (error) return error
 *   // user is available for further checks (e.g. system-admin gating)
 *
 * @returns { user, error } — exactly one will be non-null.
 */
export async function requireApiMenuAction(
  request: NextRequest,
  menu: MenuKey,
  action: ActionKey,
): Promise<{ user: AuthUser | null; error: Response | null }> {
  const user = await requireApiUser(request)
  if (user instanceof Response) return { user: null, error: user }

  const menuErr = requireMenuAccess(user, menu)
  if (menuErr) return { user: null, error: menuErr }

  const actionErr = requireActionAccess(user, action)
  if (actionErr) return { user: null, error: actionErr }

  return { user, error: null }
}
