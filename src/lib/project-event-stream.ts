/**
 * Client-side reader for the project SSE stream
 * (`GET /api/share/[token]/events/stream`).
 *
 * Uses `fetch()` + a stream reader rather than the native `EventSource` so the
 * share/admin bearer token can travel in the `Authorization` header instead of
 * the URL query string (which would leak into access logs and browser history).
 * The trade-off is that reconnection is our responsibility — handled here with
 * capped exponential backoff + jitter.
 *
 * Each SSE frame's `event:` name is the change type (`comment` / `approval` /
 * `status` / `video`); it's passed to `onEvent`. Heartbeat comment frames
 * (`: ping`) and the initial `: connected` are ignored. Frames carry no entity
 * data — `onEvent` is expected to refetch through the authenticated endpoints.
 */

export type ProjectEventType = 'comment' | 'internal' | 'approval' | 'status' | 'video' | 'upload' | 'album'

const KNOWN_TYPES: ReadonlySet<string> = new Set<ProjectEventType>(['comment', 'internal', 'approval', 'status', 'video', 'upload', 'album'])

export interface ProjectEventStreamHandle {
  close: () => void
}

interface OpenProjectEventStreamOptions {
  /** Project slug (share token in the URL sense). */
  token: string
  /** Share or admin bearer token. Null is allowed for open (authMode NONE) projects. */
  authToken: string | null
  onEvent: (type: ProjectEventType) => void
  /** Called on a 401/403 so the caller can revalidate its session if needed. */
  onAuthError?: () => void
}

const MAX_BACKOFF_MS = 30_000

export function openProjectEventStream(options: OpenProjectEventStreamOptions): ProjectEventStreamHandle {
  let closed = false
  let attempt = 0
  let controller: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleReconnect = (fixedDelay?: number) => {
    if (closed) return
    attempt += 1
    const backoff = fixedDelay ?? Math.min(1000 * 2 ** Math.min(attempt, 5), MAX_BACKOFF_MS)
    reconnectTimer = setTimeout(connect, backoff + Math.random() * 1000)
  }

  const emitFrame = (frame: string) => {
    // Pull the `event:` name out of the frame; default to 'comment' for a bare
    // data frame (shouldn't happen, but stays backward-tolerant).
    const match = frame.match(/(^|\n)event:\s*([a-z]+)/)
    const name = match?.[2]
    if (name && KNOWN_TYPES.has(name)) {
      try {
        options.onEvent(name as ProjectEventType)
      } catch {
        // Never let a handler error tear down the stream loop.
      }
    }
    // Comment/heartbeat frames (": ping", ": connected") have no `event:` line → ignored.
  }

  async function connect() {
    if (closed) return
    controller = new AbortController()
    const url = `/api/share/${encodeURIComponent(options.token)}/events/stream`

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}` } : undefined,
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        options.onAuthError?.()
        // Auth won't recover on its own quickly — back off hard rather than spin.
        scheduleReconnect(MAX_BACKOFF_MS)
        return
      }

      if (!response.ok || !response.body) {
        scheduleReconnect()
        return
      }

      // Connected successfully — reset backoff.
      attempt = 0

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          emitFrame(frame)
        }
      }

      // Server closed the stream (deploy, restart, idle cutoff) — reconnect.
      if (!closed) scheduleReconnect()
    } catch {
      // Network error or abort. If we deliberately closed, `closed` is set and
      // scheduleReconnect is a no-op; otherwise reconnect with backoff.
      if (!closed) scheduleReconnect()
    }
  }

  connect()

  return {
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      controller?.abort()
    },
  }
}
