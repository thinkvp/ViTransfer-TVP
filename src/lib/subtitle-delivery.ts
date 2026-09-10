/**
 * Caption sign-off: whether a video's .srt may be handed to a client.
 *
 * Auto-generated captions are a review aid first and a deliverable second — a
 * client who downloads raw Whisper output gets something nobody has proof-read.
 * So the SRT (the `category: 'subtitles'` VideoAsset, which otherwise inherits
 * approval-gated downloads like any other asset) is withheld from client-facing
 * listings and downloads until an admin marks it checked
 * (`Video.subtitlesApprovedAt`), unless the gate is switched off in Settings.
 *
 * Playback captions are NOT affected: the WebVTT is a separate StoredFile
 * (VIDEO/SUBTITLES_VTT) and is never approval-gated, so the CC track keeps
 * working for reviewers either way. This module gates the FILE, not the cues.
 *
 * Sign-off describes exact content, so it is set only by the explicit action
 * (`POST /api/videos/[id]/subtitles/check`) and cleared by every wholesale
 * cue write — regeneration, manual edits, an SRT set or copied from another
 * version. Same contract as the `subtitlesEdited*` columns beside it.
 */
import { getRequireSubtitleApprovalForDownload } from './settings'
import { applyDraftMarker, hasDraftMarker } from './subtitles'

export { applyDraftMarker, hasDraftMarker }

/** The canonical playback-subtitles asset category (plural — 'subtitle' is an inert upload). */
export const SUBTITLE_ASSET_CATEGORY = 'subtitles'

export interface SubtitleSignOffState {
  subtitlesApprovedAt: Date | null
}

export function isSubtitleAsset(asset: { category?: string | null }): boolean {
  return asset.category === SUBTITLE_ASSET_CATEGORY
}

interface GateableAsset {
  category?: string | null
  fileName?: string | null
}

/**
 * Whether one asset is withheld, given an already-resolved gate state. Two ways
 * to be withheld: it is the video's active captions and they are unchecked, or
 * it still carries the draft marker in its name — which covers captions demoted
 * by a later "Set SRT" (they keep the marker forever, and rightly so: nobody
 * ever checked them). A deliberate SRT upload has no marker and is unaffected.
 */
function isWithheldAsset(asset: GateableAsset, unsignedActiveCaptions: boolean): boolean {
  if (isSubtitleAsset(asset) && unsignedActiveCaptions) return true
  return hasDraftMarker(asset.fileName || '')
}

/**
 * Drop withheld caption files from a client-facing asset list. Returns the list
 * untouched for admins and when the gate is off — so every call site can pass
 * `isAdmin` straight through.
 */
export async function filterSubtitleAssetsForViewer<T extends GateableAsset>(
  assets: T[],
  video: SubtitleSignOffState,
  opts: { isAdmin: boolean },
): Promise<T[]> {
  if (opts.isAdmin || assets.length === 0) return assets
  if (!(await getRequireSubtitleApprovalForDownload())) return assets
  const unsigned = !video.subtitlesApprovedAt
  return assets.filter((asset) => !isWithheldAsset(asset, unsigned))
}

/** Single-asset form of the same rule, for the per-asset download routes. */
export async function isSubtitleAssetWithheldForViewer(
  asset: GateableAsset,
  video: SubtitleSignOffState,
  opts: { isAdmin: boolean },
): Promise<boolean> {
  if (opts.isAdmin) return false
  if (!(await getRequireSubtitleApprovalForDownload())) return false
  return isWithheldAsset(asset, !video.subtitlesApprovedAt)
}
