// Attachment contract for AI assistant requests — shared by the API route
// (validation), the worker (text extraction), and the admin UI (typing).

// 'audio' is used only by dictation requests (kind: 'dictation'), which skip
// the text-extraction path entirely — the transcription worker consumes the
// base64 directly and clears it after transcribing.
export type AiAttachmentKind = 'email' | 'document' | 'audio'

export interface AiRequestAttachment {
  fileName: string
  kind: AiAttachmentKind
  size: number
  /** MIME type — set for audio (dictation) attachments so Whisper gets the right container hint */
  mimeType?: string | null
  /** Base64 file content; present until the worker extracts text, then cleared */
  contentBase64?: string | null
  /** Worker-extracted text fed to the LLM (audit) */
  extractedText?: string | null
  /** Set when extraction failed — the request continues without this attachment */
  extractionError?: string | null
}

export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB per file
// base64 inflates by 4/3
export const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4
/** Cap on extracted text per attachment fed into the prompt */
export const MAX_EXTRACTED_CHARS = 30_000

const EMAIL_EXTENSIONS = ['.eml']
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt']
export const ALLOWED_ATTACHMENT_EXTENSIONS = [...EMAIL_EXTENSIONS, ...DOCUMENT_EXTENSIONS]
/** For <input accept> */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.join(',')

export function attachmentExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : ''
}

export function attachmentKindForFileName(fileName: string): AiAttachmentKind | null {
  const ext = attachmentExtension(fileName)
  if (EMAIL_EXTENSIONS.includes(ext)) return 'email'
  if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document'
  return null
}

/**
 * Light magic-byte check on the decoded content. Not a substitute for the
 * project's full file validation — the originals go to the project via the
 * existing (fully validated) upload endpoints; this only guards what the
 * worker will try to parse.
 */
export function attachmentContentLooksValid(fileName: string, bytes: Uint8Array): boolean {
  const ext = attachmentExtension(fileName)
  if (ext === '.pdf') {
    // %PDF
    return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  }
  if (ext === '.docx') {
    // ZIP local file header: PK\x03\x04
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  }
  // .eml / .txt are plain text — accept anything non-empty
  return bytes.length > 0
}
