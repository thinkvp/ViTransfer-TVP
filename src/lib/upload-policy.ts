/**
 * Pure file-type policy for client uploads: the allow/block lists, the system-wide category
 * policy, and the validator built on them.
 *
 * Deliberately dependency-free so it can be imported from anywhere — client components, the
 * settings cache, and the Edge-compiled instrumentation bundle alike. Path building and other
 * Node-only helpers live in fileUpload.ts, which re-exports everything here.
 */

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

  // Audio
  "audio/mpeg": { ext: "mp3", category: "audio" },
  "audio/wav": { ext: "wav", category: "audio" },
  "audio/x-wav": { ext: "wav", category: "audio" },
  "audio/aac": { ext: "aac", category: "audio" },
  "audio/flac": { ext: "flac", category: "audio" },
  "audio/ogg": { ext: "ogg", category: "audio" },
  "audio/mp4": { ext: "m4a", category: "audio" },
  "audio/x-aiff": { ext: "aiff", category: "audio" },
  "audio/aiff": { ext: "aiff", category: "audio" },
  "audio/x-ms-wma": { ext: "wma", category: "audio" },

  // Project files (Premiere Pro / After Effects / DaVinci Resolve)
  "application/vnd.adobe.premiere.project": { ext: "prproj", category: "project" },
  "application/x-premiere-project": { ext: "prproj", category: "project" },
  "application/vnd.adobe.aftereffects.project": { ext: "aep", category: "project" },
  "application/x-aftereffects": { ext: "aep", category: "project" },
  "application/x-davinci-resolve-project": { ext: "drp", category: "project" },
  "application/x-davinci-resolve-archive": { ext: "dra", category: "project" },
  "application/x-davinci-resolve-timeline": { ext: "drt", category: "project" },
  // Motion Graphics Templates are ZIP containers, so browsers usually report them as an
  // archive MIME or nothing at all; the extension fallback in validateCommentFile is what
  // actually lands them in Project Files when Archives is switched off.
  "application/x-adobe-mogrt": { ext: "mogrt", category: "project" },

  // Videos
  "video/mp4": { ext: "mp4", category: "video" },
  "video/quicktime": { ext: "mov", category: "video" },
  "video/x-m4v": { ext: "m4v", category: "video" },
  "video/webm": { ext: "webm", category: "video" },
  "video/x-matroska": { ext: "mkv", category: "video" },
  "video/x-msvideo": { ext: "avi", category: "video" },
  "video/mxf": { ext: "mxf", category: "video" },
  "application/mxf": { ext: "mxf", category: "video" },
  "application/x-mxf": { ext: "mxf", category: "video" },

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
 * The category tickboxes an administrator sees, in display order. The extension list for each
 * is derived from ALLOWED_FILE_TYPES rather than written out by hand, so adding a MIME type
 * above is enough to update every "supported types" string in the UI.
 */
export const UPLOAD_CATEGORIES = [
  { key: "image", label: "Images" },
  { key: "video", label: "Videos" },
  { key: "audio", label: "Audio" },
  { key: "project", label: "Project Files" },
  { key: "document", label: "Documents" },
  { key: "font", label: "Fonts" },
  { key: "archive", label: "Archives" },
] as const;

export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number]["key"];

const UPLOAD_CATEGORY_KEYS: readonly string[] = UPLOAD_CATEGORIES.map((c) => c.key);

/**
 * System-wide policy for what clients may upload. Held on Settings, not per project.
 */
export interface ClientUploadPolicy {
  categories: string[];
  customExtensions: string[];
}

export const DEFAULT_CLIENT_UPLOAD_POLICY: ClientUploadPolicy = {
  categories: [...UPLOAD_CATEGORY_KEYS],
  customExtensions: [],
};

/** Longest extension we will accept in the custom box (".prproj" is 6). */
const MAX_CUSTOM_EXTENSION_LENGTH = 10;
const MAX_CUSTOM_EXTENSIONS = 50;

/** Extensions covered by a category, in the order their MIME types are declared above. */
export function getCategoryExtensions(category: string): string[] {
  const seen: string[] = [];
  for (const entry of Object.values(ALLOWED_FILE_TYPES)) {
    if (entry.category === category && !seen.includes(entry.ext)) seen.push(entry.ext);
  }
  return seen;
}

export function isBlockedExtension(extension: string): boolean {
  return BLOCKED_FILE_EXTENSIONS.has(extension.replace(/^\./, "").toLowerCase());
}

export function normalizeUploadCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(
    value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase())
  );
  // Keep display order regardless of the order they arrived in, and drop unknown keys.
  return UPLOAD_CATEGORY_KEYS.filter((key) => set.has(key));
}

/**
 * Turn free text ("psd, .fcpxml; blend") into a clean extension list.
 * Blocked extensions are reported separately so the caller can refuse the save and say why —
 * the blocklist is never overridable from the UI.
 */
export function parseCustomExtensions(input: unknown): { extensions: string[]; blocked: string[] } {
  const raw = Array.isArray(input)
    ? input.filter((v): v is string => typeof v === "string")
    : typeof input === "string"
      ? input.split(/[\s,;]+/)
      : [];

  const extensions: string[] = [];
  const blocked: string[] = [];

  for (const token of raw) {
    const ext = token
      .trim()
      .replace(/^\*?\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!ext || ext.length > MAX_CUSTOM_EXTENSION_LENGTH) continue;
    if (BLOCKED_FILE_EXTENSIONS.has(ext)) {
      if (!blocked.includes(ext)) blocked.push(ext);
      continue;
    }
    if (!extensions.includes(ext)) extensions.push(ext);
  }

  return { extensions: extensions.slice(0, MAX_CUSTOM_EXTENSIONS), blocked };
}

/**
 * Read a policy back out of the two Settings columns (both JSON strings, like
 * defaultPreviewResolutions). Anything unparseable falls back to "everything allowed",
 * which is the behaviour every install had before this setting existed.
 */
export function parseClientUploadPolicy(
  categoriesJson: string | null | undefined,
  customExtensionsJson: string | null | undefined
): ClientUploadPolicy {
  let categories = DEFAULT_CLIENT_UPLOAD_POLICY.categories;
  if (categoriesJson) {
    try {
      categories = normalizeUploadCategories(JSON.parse(categoriesJson));
    } catch {
      // keep the default
    }
  }

  let customExtensions: string[] = [];
  if (customExtensionsJson) {
    try {
      customExtensions = parseCustomExtensions(JSON.parse(customExtensionsJson)).extensions;
    } catch {
      // keep empty
    }
  }

  return { categories, customExtensions };
}

/**
 * Validate file for comment upload
 * @param fileName - Original file name
 * @param mimeType - Browser-reported MIME type
 * @param _fileSize - File size in bytes (unused; size is enforced by the quota check)
 * @param policy - Client upload policy. Omit for admin/internal uploads, which are not
 *                 restricted by the client-facing category setting.
 * @returns { valid: boolean, error?: string }
 */
export function validateCommentFile(
  fileName: string,
  mimeType: string,
  _fileSize: number,
  policy: ClientUploadPolicy = DEFAULT_CLIENT_UPLOAD_POLICY
): { valid: boolean; error?: string } {
  // Check file extension against blocklist. This runs first and is never overridable.
  const fileExtension = fileName.split(".").pop()?.toLowerCase();
  if (fileExtension && BLOCKED_FILE_EXTENSIONS.has(fileExtension)) {
    return {
      valid: false,
      error: `File type .${fileExtension} is not allowed`,
    };
  }

  const allowedCategories = new Set(policy.categories);

  // Explicitly listed custom extensions bypass the category whitelist (but not the blocklist)
  if (fileExtension && policy.customExtensions.includes(fileExtension)) {
    return { valid: true };
  }

  // Check MIME type against whitelist
  const byMime = ALLOWED_FILE_TYPES[mimeType as keyof typeof ALLOWED_FILE_TYPES];
  if (byMime && allowedCategories.has(byMime.category)) {
    return { valid: true };
  }

  // Fallback: check by extension if the MIME type was not recognized, or named a category
  // that is switched off while the extension belongs to one that is on.
  if (fileExtension) {
    const byExt = Object.values(ALLOWED_FILE_TYPES).find((t) => t.ext === fileExtension);
    if (byExt && allowedCategories.has(byExt.category)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: `File type ${mimeType || fileExtension} is not allowed`,
  };
}

/**
 * Get human-readable list of allowed file types
 */
export function getAllowedFileTypesDescription(
  policy: ClientUploadPolicy = DEFAULT_CLIENT_UPLOAD_POLICY
): string {
  const parts = UPLOAD_CATEGORIES.filter((c) => policy.categories.includes(c.key)).map(
    (c) => `${c.label} (${getCategoryExtensions(c.key).join(", ").toUpperCase()})`
  );

  if (policy.customExtensions.length > 0) {
    parts.push(`Other (${policy.customExtensions.join(", ").toUpperCase()})`);
  }

  if (parts.length === 0) return "No file types are currently allowed.";

  return parts.join(" • ");
}

