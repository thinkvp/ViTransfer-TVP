/**
 * Shared client-side shape of a project video as delivered by the API.
 *
 * This is the Prisma `Video` subset that reaches the browser plus a few
 * computed/serialized fields the API adds (stream/download/thumbnail URLs,
 * timeline preview URLs, original-file metadata). It is hand-written on
 * purpose: client components must not import Prisma runtime types, and the
 * JSON payload differs from the DB row (e.g. `createdAt` is a string,
 * `originalFileSize` is a stringified number).
 *
 * Fields that are non-null in the schema and always selected are required;
 * nullable columns and API-computed extras are optional.
 */
export interface Video {
  // Core (Prisma non-null, always selected)
  id: string
  name: string
  version: number
  versionLabel: string
  duration: number // seconds
  width: number
  height: number
  approved: boolean

  // Nullable columns
  fps?: number | null
  codec?: string | null
  videoNotes?: string | null
  allowApproval?: boolean
  timelinePreviewsReady?: boolean
  createdAt?: string // serialized DateTime

  // Computed / API-added (not always present)
  streamUrl?: string
  streamUrlOriginal?: string
  streamUrl480p?: string
  streamUrl720p?: string
  streamUrl1080p?: string
  thumbnailUrl?: string | null
  downloadUrl?: string | null
  timelineVttUrl?: string | null
  timelineSpriteUrl?: string | null
  originalFileName?: string
  originalFileSize?: string // stringified number
}
