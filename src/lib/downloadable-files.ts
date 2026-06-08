export type DownloadableFileType = 'video' | 'asset' | 'album-zip' | 'album-photo' | 'upload-file'

export interface DownloadableFile {
  type: DownloadableFileType
  fileName: string
  /** Optional file size in bytes. */
  fileSizeBytes?: number | string
  /** Optional media duration in seconds (videos). */
  durationSeconds?: number
  /** Version label for video files (e.g. "v1", "v2"). */
  versionLabel?: string
  /** Approval status for video versions. */
  isApproved?: boolean
  /** Whether approval is enabled for this video version. */
  allowApproval?: boolean
  /** Set for type 'video' and 'asset' */
  videoId?: string
  /** Set for type 'asset' */
  assetId?: string
  /** Set for type 'album-zip' */
  albumId?: string
  /** Set for type 'album-photo' */
  photoId?: string
  /** Set for type 'upload-file' */
  uploadFileId?: string
  /** Set for type 'upload-file' */
  uploadFolderPath?: string
  /** Target sub-folder path within an FSA bulk download directory (set at download time). */
  downloadFolderPath?: string
  /** Set for type 'album-zip' */
  variant?: 'full' | 'social'
  /** Optional tokenized preview URL (e.g. album photo thumbnail). */
  thumbnailUrl?: string
  /** Optional tokenized preview URL (e.g. album photo social-size preview). */
  previewUrl?: string
  /** Preview generation lifecycle status for upload files. */
  previewStatus?: string
  /** Optional tokenized direct download URL. */
  downloadUrl?: string
  /** Whether this video has timeline hover previews (sprite sheets + VTT). */
  hasTimelinePreviews?: boolean
  /** Tokenized URL to the timeline VTT index file. */
  timelineVttUrl?: string
  /** Tokenized base URL for timeline sprite images (append sprite filename). */
  timelineSpriteBaseUrl?: string
}

export interface DownloadableGroup {
  name: string
  groupType: 'video' | 'album' | 'uploads'
  /** For video groups: the approved version's original file. Undefined for album groups. */
  mainFile?: DownloadableFile
  /** For video groups: the approved version's assets (shown indented). For album groups: the zip files. */
  subFiles: DownloadableFile[]
}

export interface DownloadableFilesResult {
  groups: DownloadableGroup[]
  hasApprovableVideos: boolean
}
