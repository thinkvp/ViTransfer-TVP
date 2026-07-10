/**
 * Shared project-event type definitions.
 *
 * Imported by BOTH the server publisher/subscriber (`project-events.ts`, which
 * pulls in Redis and must never reach the client bundle) and the client stream
 * reader (`project-event-stream.ts`). Keeping the type + known-set here means a
 * new event type cannot silently exist on one side only: this module has no
 * runtime dependencies, so it is safe in either bundle.
 */

export type ProjectEventType = 'comment' | 'internal' | 'approval' | 'status' | 'video' | 'upload' | 'album'

export const PROJECT_EVENT_TYPES: ReadonlySet<string> = new Set<ProjectEventType>([
  'comment',
  'internal',
  'approval',
  'status',
  'video',
  'upload',
  'album',
])
