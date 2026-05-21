export type DownloadableFileType = 'video' | 'asset' | 'album-zip'

export interface DownloadableFile {
  type: DownloadableFileType
  fileName: string
  /** Optional file size in bytes. */
  fileSizeBytes?: number | string
  /** Optional media duration in seconds (videos). */
  durationSeconds?: number
  /** Set for type 'video' and 'asset' */
  videoId?: string
  /** Set for type 'asset' */
  assetId?: string
  /** Set for type 'album-zip' */
  albumId?: string
  /** Set for type 'album-zip' */
  variant?: 'full' | 'social'
}

export interface DownloadableGroup {
  name: string
  groupType: 'video' | 'album'
  /** For video groups: the approved version's original file. Undefined for album groups. */
  mainFile?: DownloadableFile
  /** For video groups: the approved version's assets (shown indented). For album groups: the zip files. */
  subFiles: DownloadableFile[]
}

export interface DownloadableFilesResult {
  groups: DownloadableGroup[]
  hasApprovableVideos: boolean
}
