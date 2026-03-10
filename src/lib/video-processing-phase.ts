export const VALID_PREVIEW_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export type PreviewResolution = typeof VALID_PREVIEW_RESOLUTIONS[number]

export const PROCESSING_PHASES = {
  transcode: 'transcode',
  thumbnail: 'thumbnail',
  timeline: 'timeline',
} as const

const TRANSCODE_PHASE_PREFIX = `${PROCESSING_PHASES.transcode}:`

export function getPreviewProcessingPhase(resolution: string | null | undefined): string {
  if (!resolution || !VALID_PREVIEW_RESOLUTIONS.includes(resolution as PreviewResolution)) {
    return PROCESSING_PHASES.transcode
  }

  return `${TRANSCODE_PHASE_PREFIX}${resolution}`
}

export function getPreviewResolutionFromPhase(phase: string | null | undefined): PreviewResolution | null {
  if (!phase || !phase.startsWith(TRANSCODE_PHASE_PREFIX)) {
    return null
  }

  const resolution = phase.slice(TRANSCODE_PHASE_PREFIX.length)
  return VALID_PREVIEW_RESOLUTIONS.includes(resolution as PreviewResolution)
    ? (resolution as PreviewResolution)
    : null
}

export function getProcessingPhaseLabel(phase: string | null | undefined): string {
  const resolution = getPreviewResolutionFromPhase(phase)
  if (resolution) return `Processing ${resolution} previews...`

  switch (phase) {
    case PROCESSING_PHASES.transcode:
      return 'Processing previews...'
    case PROCESSING_PHASES.thumbnail:
      return 'Generating thumbnail...'
    case PROCESSING_PHASES.timeline:
      return 'Generating timeline previews...'
    default:
      return 'Processing...'
  }
}