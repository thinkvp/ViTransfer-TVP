/** Mirrors the Prisma `VideoStatus` enum (hand-written to avoid a runtime import). */
export type VideoStatus = 'UPLOADING' | 'QUEUED' | 'PROCESSING' | 'READY' | 'ERROR'

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
  // Same-origin HLS master playlist (proxy-robust segmented playback). When present the
  // player prefers it over the single-file MP4 stream URLs above.
  hlsUrl?: string
  // Whether the HLS bundle is keyframe-aligned (ABR-safe). When true the player lets hls.js
  // adapt bitrate automatically in "Auto"; when false it pins the level (legacy renditions).
  hlsAbr?: boolean
  thumbnailUrl?: string | null
  downloadUrl?: string | null
  timelineVttUrl?: string | null
  timelineSpriteUrl?: string | null
  originalFileName?: string
  originalFileSize?: string // stringified number

  // Admin / processing / analytics (admin views only, e.g. VideoList)
  projectId?: string
  status?: VideoStatus
  processingProgress?: number
  processingError?: string | null
  viewCount?: number
  downloadCount?: number
}
