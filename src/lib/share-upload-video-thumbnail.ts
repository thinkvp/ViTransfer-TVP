export function isShareUploadImageFileType(fileType: string | null | undefined): boolean {
  return String(fileType || '').toLowerCase().startsWith('image/')
}

export function isShareUploadVideoFileType(fileType: string | null | undefined): boolean {
  return String(fileType || '').toLowerCase().startsWith('video/')
}
