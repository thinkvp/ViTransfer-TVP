/**
 * File upload configuration and utilities for comment attachments
 */

// Maximum file size per attachment: 200MB
export const MAX_COMMENT_FILE_SIZE = 200 * 1024 * 1024;

// Maximum number of files per comment
export const MAX_FILES_PER_COMMENT = 5;

// Allowed file types for comment attachments
export const ALLOWED_FILE_TYPES = {
  // Images
  "image/jpeg": { ext: "jpg", category: "image" },
  "image/png": { ext: "png", category: "image" },
  "image/gif": { ext: "gif", category: "image" },
  "image/webp": { ext: "webp", category: "image" },
  "image/tiff": { ext: "tiff", category: "image" },
  "image/svg+xml": { ext: "svg", category: "image" },

  // Adobe images
  "image/vnd.adobe.photoshop": { ext: "psd", category: "image" },
  "application/vnd.adobe.photoshop": { ext: "psd", category: "image" },
  "application/x-photoshop": { ext: "psd", category: "image" },
  "application/photoshop": { ext: "psd", category: "image" },
  // Some PSD/PSB uploads come through as unknown MIME types; allow by extension fallback
  "application/x-photoshop-large": { ext: "psb", category: "image" },

  // Documents - PDF
  "application/pdf": { ext: "pdf", category: "document" },

  // Microsoft Office
  "application/msword": { ext: "doc", category: "document" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: "docx",
    category: "document",
  },
  "application/vnd.ms-excel": { ext: "xls", category: "document" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    ext: "xlsx",
    category: "document",
  },
  "application/vnd.ms-powerpoint": { ext: "ppt", category: "document" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    ext: "pptx",
    category: "document",
  },

  // Fonts
  "font/ttf": { ext: "ttf", category: "font" },
  "font/otf": { ext: "otf", category: "font" },
  "application/font-sfnt": { ext: "ttf", category: "font" },
  "application/font-woff": { ext: "woff", category: "font" },
  "font/woff": { ext: "woff", category: "font" },
  "application/font-woff2": { ext: "woff2", category: "font" },
  "font/woff2": { ext: "woff2", category: "font" },

  // Adobe files
  "application/x-sharedobject": { ext: "swf", category: "document" },
  "application/postscript": { ext: "ps", category: "document" },
  "application/vnd.adobe.illustrator": { ext: "ai", category: "document" },

  // Videos
  "video/mp4": { ext: "mp4", category: "video" },
  "video/quicktime": { ext: "mov", category: "video" },
  "video/x-m4v": { ext: "m4v", category: "video" },
  "video/webm": { ext: "webm", category: "video" },
  "video/x-matroska": { ext: "mkv", category: "video" },
  "video/x-msvideo": { ext: "avi", category: "video" },

  // Compressed - ONLY allow standard archives (NO exe, dll, or other executables)
  "application/x-zip-compressed": { ext: "zip", category: "archive" },
  "application/zip": { ext: "zip", category: "archive" },
  "application/x-rar-compressed": { ext: "rar", category: "archive" },
  "application/x-7z-compressed": { ext: "7z", category: "archive" },
  "application/gzip": { ext: "gz", category: "archive" },
  "application/x-tar": { ext: "tar", category: "archive" },
};

// Blocklist - explicitly disallow dangerous file types
export const BLOCKED_FILE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "sys",
  "scr",
  "bat",
  "cmd",
  "com",
  "pif",
  "msi",
  "app",
  "sh",
  "bash",
  "bin",
  "jar",
  "class",
  "vbs",
  "js", // JavaScript files in uploads
  "jse",
  "wsf",
  "wsh",
  "lnk",
  "inf",
  "reg",
  "ps1",
  "psm1",
  "psc1",
  "psd1",
  "msh",
  "msh1",
  "msh2",
  "mshxml",
  "msh1xml",
  "msh2xml",
  "run",
  "nt",
  "crt",
  "cab",
  "msu",
  "scf",
  "ppl",
  "chm",
  "hta",
  "cpl",
]);

/**
 * Validate file for comment upload
 * @param file - File to validate
 * @param fileSize - File size in bytes
 * @returns { valid: boolean, error?: string }
 */
export function validateCommentFile(
  fileName: string,
  mimeType: string,
  fileSize: number
): { valid: boolean; error?: string } {
  // Check file size
  if (fileSize > MAX_COMMENT_FILE_SIZE) {
    return {
      valid: false,
      error: `File size exceeds maximum of ${MAX_COMMENT_FILE_SIZE / (1024 * 1024)}MB`,
    };
  }

  // Check file extension against blocklist
  const fileExtension = fileName.split(".").pop()?.toLowerCase();
  if (fileExtension && BLOCKED_FILE_EXTENSIONS.has(fileExtension)) {
    return {
      valid: false,
      error: `File type .${fileExtension} is not allowed`,
    };
  }

  // Check MIME type against whitelist
  if (!ALLOWED_FILE_TYPES[mimeType as keyof typeof ALLOWED_FILE_TYPES]) {
    // Fallback: check by extension if MIME type not recognized
    if (!fileExtension || !Object.values(ALLOWED_FILE_TYPES).some((t) => t.ext === fileExtension)) {
      return {
        valid: false,
        error: `File type ${mimeType || fileExtension} is not allowed`,
      };
    }
  }

  return { valid: true };
}

/**
 * Get human-readable list of allowed file types
 */
export function getAllowedFileTypesDescription(): string {
  const categories = {
    image: "Images (JPG, PNG, GIF, WebP, TIFF, SVG, PSD, PSB, AI)",
    video: "Videos (MP4, MOV, M4V, WEBM, MKV, AVI)",
    document: "Documents (PDF, Word, Excel, PowerPoint)",
    font: "Fonts (TTF, OTF, WOFF, WOFF2)",
    archive: "Archives (ZIP, RAR, 7Z, GZ, TAR)",
  };

  return Object.values(categories).join(" • ");
}

/**
 * Generate safe storage path for comment file
 * @param projectId - Project ID
 * @param commentId - Comment ID
 * @param fileName - Original file name
 * @returns Safe storage path
 */
export function generateCommentFilePath(projectId: string, commentId: string, fileName: string): string {
  // Sanitize filename and ensure it doesn't contain path traversal attempts
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

  // Generate unique filename to avoid collisions
  const timestamp = Date.now();
  const extension = sanitized.split(".").pop();
  const nameWithoutExt = sanitized.slice(0, sanitized.length - (extension ? extension.length + 1 : 0));

  const finalFileName = `${nameWithoutExt}_${timestamp}.${extension || "bin"}`;

  return `projects/${projectId}/comments/${commentId}/${finalFileName}`;
}
