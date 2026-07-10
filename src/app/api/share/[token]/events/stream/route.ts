import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { subscribeToProjectEvents, type ProjectEventType } from '@/lib/project-events'
import { getRateLimitSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/share/[token]/events/stream
 *
 * Server-Sent Events channel for near-real-time project updates. Holds a
 * long-lived connection open and pushes a frame whenever something changes on
 * this project — a comment, an approval, a status change, or a video finishing
 * processing (via Redis pub/sub; see `src/lib/project-events.ts`). The event
 * TYPE is the SSE event name (`event: comment` / `approval` / `status` /
 * `video`); the client maps each type to the right refetch.
 *
 * Frames carry no entity content — only a "changed" signal — so the actual data
 * still flows through the authenticated + sanitized endpoints.
 *
 * Auth uses the standard `Authorization: Bearer` header (share or admin token),
 * so the client opens this with `fetch()` + a stream reader rather than the
 * native `EventSource`, which cannot set headers (and would otherwise leak the
 * token into the URL/query string and access logs). The admin project dashboard
 * uses the same endpoint via the admin path in `verifyProjectAccess`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const { ipRateLimit } = await getRateLimitSettings()

  // Light rate limit on connection opens (client uses backoff on reconnect).
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: ipRateLimit ? Math.max(1, Math.min(ipRateLimit, 1000)) : 30,
    message: 'Too many requests. Please slow down.',
  }, `share-events-stream:${token}`)
  if (rateLimitResult) return rateLimitResult

  const project = await prisma.project.findUnique({
    where: { slug: token },
    select: {
      id: true,
      sharePassword: true,
      authMode: true,
      hideFeedback: true,
      status: true,
    },
  })

  if (!project) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const accessCheck = await verifyProjectAccess(
    request,
    project.id,
    project.sharePassword,
    project.authMode,
  )
  if (!accessCheck.authorized) {
    return accessCheck.errorResponse ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // When feedback is hidden, non-admins see no comments — so don't leak comment
  // activity timing to them. Guests (guest video links) can never see comments,
  // so they get no comment events either. Approval/status/video events are not
  // sensitive in that way, so they still flow. NOTE: evaluated once at connect
  // time; a mid-stream `hideFeedback` toggle applies from the next reconnect.
  const canSeeComments = accessCheck.isAdmin || (!project.hideFeedback && !accessCheck.isGuest)

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let cleanedUp = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        if (heartbeat) clearInterval(heartbeat)
        if (unsubscribe) unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }

      const send = (chunk: string) => {
        if (cleanedUp) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // Controller already closed without the abort signal firing (e.g. the
          // response was torn down) — release the Redis listener and heartbeat
          // rather than relying solely on the abort event.
          cleanup()
        }
      }

      send(': connected\n\n')

      // Client disconnect (tab closed, navigation, network drop).
      if (request.signal.aborted) {
        cleanup()
        return
      }
      request.signal.addEventListener('abort', cleanup)

      // Start the heartbeat BEFORE subscribing: if Redis is down, the subscribe
      // below can stall until it reconnects, and with no bytes flowing a proxy
      // would kill the "idle" connection in the meantime.
      heartbeat = setInterval(() => send(': ping\n\n'), 25000)

      try {
        unsubscribe = await subscribeToProjectEvents(project.id, (type: ProjectEventType) => {
          // Internal team comments are admin-only — never leak their timing to clients.
          if (type === 'internal' && !accessCheck.isAdmin) return
          if (type === 'comment' && !canSeeComments) return
          send(`event: ${type}\ndata: {}\n\n`)
        })
        // The client may have disconnected while the subscribe was in flight —
        // cleanup() already ran with `unsubscribe` still null, so release the
        // listener now or it (and the project's Redis channel) leaks forever.
        if (cleanedUp && unsubscribe) {
          unsubscribe()
          unsubscribe = null
        }
      } catch (error) {
        console.error('[events-stream] subscribe failed:', (error as Error)?.message)
      }
    },

    cancel() {
      if (cleanedUp) return
      cleanedUp = true
      if (heartbeat) clearInterval(heartbeat)
      if (unsubscribe) unsubscribe()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Defeat proxy response buffering (nginx); harmless under Caddy.
      'X-Accel-Buffering': 'no',
    },
  })
}
