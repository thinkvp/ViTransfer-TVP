/**
 * Availability/authorization check for share-page video access tokens.
 *
 * Shared by the single-token GET route and its batch POST sibling
 * (src/app/api/share/[token]/video-token/route.ts and .../video-token/batch/route.ts)
 * so the two can never drift on what a share session may be issued.
 */
export function canIssueShareVideoToken(
  storedRoles: Set<string>,
  approved: boolean,
  quality: string,
): boolean {
  const canUseOriginal = approved
  // Since the direct-to-HLS migration (2.1.0), a video's only preview is its HLS bundle —
  // no MP4 PREVIEW_* roles are written. The HLS master URL is minted alongside any
  // streaming-quality token, so a streaming-quality request must be allowed whenever an
  // HLS bundle exists; otherwise unapproved HLS-only videos can never obtain a stream and
  // won't play for clients. HLS segments ARE the preview, so this exposes no more than the
  // old MP4 preview roles did — the original/download cases stay approval-gated.
  const hasHls = storedRoles.has('HLS_PLAYLIST')

  switch (quality) {
    case '480p':
      return hasHls || storedRoles.has('PREVIEW_480') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || canUseOriginal
    case '720p':
      return hasHls || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case '1080p':
      return hasHls || storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case 'thumbnail':
      return storedRoles.has('THUMBNAIL')
    case 'timeline-vtt':
      return storedRoles.has('TIMELINE_VTT')
    case 'timeline-sprite':
      return storedRoles.has('TIMELINE_SPRITES')
    // Captions are needed while reviewing, so like timeline previews they are
    // NOT approval-gated (the SRT asset download stays approval-gated).
    case 'subtitles-vtt':
      return storedRoles.has('SUBTITLES_VTT')
    // Waveform peaks back the subtitle editor's timeline strip — edit-time
    // artifact, NOT approval-gated (same rationale as subtitles-vtt).
    case 'waveform-peaks':
      return storedRoles.has('WAVEFORM_PEAKS')
    case 'original':
    case 'download':
      return canUseOriginal && storedRoles.has('ORIGINAL')
    default:
      return false
  }
}
