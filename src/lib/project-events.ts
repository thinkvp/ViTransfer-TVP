/**
 * Project change events (Redis pub/sub)
 *
 * Powers near-real-time updates on the share page and admin project dashboard.
 * When something collaborative changes on a project — a comment is
 * created/edited/deleted/resolved, a video is approved/unapproved, the project
 * status changes, or a video finishes processing — the mutating code calls
 * `publishProjectEvent(projectId, type)`. Every open page holds a Server-Sent
 * Events stream (see `src/app/api/share/[token]/events/stream/route.ts`) that
 * subscribes via `subscribeToProjectEvents` and, on each event, tells the client
 * which slice to refetch — so activity by anyone shows up for everyone without a
 * manual refresh or a blanket polling timer.
 *
 * Design notes:
 * - ONE channel per project carrying a typed event, so a page needs a single SSE
 *   connection regardless of how many kinds of update it cares about.
 * - Publishing runs on the shared `getRedis()` connection (a normal command).
 *   The web app and the worker both publish (the worker emits `video` when a
 *   transcode completes).
 * - Subscribing runs on ONE dedicated subscriber connection (`getRedisSubscriber`)
 *   with an in-process fan-out registry, so N open SSE clients still use a single
 *   Redis connection. The channel is per-project so a subscriber only wakes for
 *   its own project's activity.
 * - The payload carries only the event TYPE — never comment content or entity
 *   data. Clients refetch through the properly-authenticated endpoints, which
 *   enforce access control, `hideFeedback`, and PII sanitization. This keeps the
 *   event channel free of anything sensitive.
 */

import { getRedis, getRedisSubscriber, ensureRedisReady } from './redis'

const CHANNEL_PREFIX = 'project-events:'

export type ProjectEventType = 'comment' | 'internal' | 'approval' | 'status' | 'video' | 'upload' | 'album'

const KNOWN_TYPES: ReadonlySet<string> = new Set<ProjectEventType>(['comment', 'internal', 'approval', 'status', 'video', 'upload', 'album'])

type Listener = (type: ProjectEventType) => void

// projectId -> set of local listeners (one per open SSE connection on this process)
const listeners = new Map<string, Set<Listener>>()
let handlerBound = false

function bindMessageHandler(): void {
  if (handlerBound) return
  handlerBound = true
  const sub = getRedisSubscriber()
  sub.on('message', (channel: string, message: string) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return
    const projectId = channel.slice(CHANNEL_PREFIX.length)
    const type = (KNOWN_TYPES.has(message) ? message : 'comment') as ProjectEventType
    const set = listeners.get(projectId)
    if (!set) return
    // Copy before iterating: a listener may unsubscribe itself synchronously.
    for (const listener of Array.from(set)) {
      try {
        listener(type)
      } catch {
        // A single misbehaving listener must not break fan-out to the others.
      }
    }
  })
}

/**
 * Announce that something changed on a project. Best-effort: never throws, so a
 * Redis blip can't break the underlying mutation (comment, approval, etc.).
 */
export async function publishProjectEvent(projectId: string, type: ProjectEventType): Promise<void> {
  if (!projectId) return
  try {
    const redis = getRedis()
    await ensureRedisReady(redis)
    await redis.publish(CHANNEL_PREFIX + projectId, type)
  } catch (error) {
    console.error('[project-events] publish failed:', (error as Error)?.message)
  }
}

/**
 * Register a listener for a project's events.
 * Returns an unsubscribe function that MUST be called on teardown (SSE close).
 */
export async function subscribeToProjectEvents(
  projectId: string,
  listener: Listener,
): Promise<() => void> {
  const sub = getRedisSubscriber()
  await ensureRedisReady(sub)
  bindMessageHandler()

  let set = listeners.get(projectId)
  if (!set) {
    set = new Set()
    listeners.set(projectId, set)
    // First listener for this project on this process → subscribe the channel.
    await sub.subscribe(CHANNEL_PREFIX + projectId)
  }
  set.add(listener)

  let released = false
  return () => {
    if (released) return
    released = true
    const current = listeners.get(projectId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(projectId)
      // Last listener gone → drop the channel subscription (best-effort).
      sub.unsubscribe(CHANNEL_PREFIX + projectId).catch(() => {})
    }
  }
}
