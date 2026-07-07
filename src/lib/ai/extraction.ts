// Attachment text extraction — WORKER-ONLY module (pulls in mailparser, unpdf,
// mammoth). Do not import from client components or web API routes.
import { simpleParser } from 'mailparser'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import { attachmentExtension, MAX_EXTRACTED_CHARS, type AiRequestAttachment } from './attachments'

async function extractEmailText(buffer: Buffer): Promise<string> {
  const parsed = await simpleParser(buffer, {
    skipTextToHtml: true,
    skipHtmlToText: false,
  })
  const from = parsed.from?.text ?? ''
  const to = parsed.to && 'text' in parsed.to ? parsed.to.text : ''
  const subject = parsed.subject ?? ''
  const body = parsed.text ?? ''
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body}`.trim()
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return text.trim()
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  return result.value.trim()
}

/**
 * Extract text from one attachment. Returns a new attachment object with
 * `extractedText` set (or `extractionError`) and `contentBase64` cleared —
 * raw bytes are not kept in the DB; the browser attaches the originals to the
 * created project through the existing upload endpoints.
 */
export async function extractAttachmentText(attachment: AiRequestAttachment): Promise<AiRequestAttachment> {
  const { contentBase64, ...rest } = attachment
  if (!contentBase64) {
    return { ...rest, contentBase64: null, extractionError: attachment.extractionError ?? 'No content provided' }
  }

  try {
    const buffer = Buffer.from(contentBase64, 'base64')
    const ext = attachmentExtension(attachment.fileName)

    let text: string
    if (attachment.kind === 'email') {
      text = await extractEmailText(buffer)
    } else if (ext === '.pdf') {
      text = await extractPdfText(buffer)
    } else if (ext === '.docx') {
      text = await extractDocxText(buffer)
    } else {
      // .txt and anything else that made it through validation: treat as UTF-8
      text = buffer.toString('utf8').trim()
    }

    if (!text) {
      return { ...rest, contentBase64: null, extractionError: 'No text could be extracted (scanned/image-only file?)' }
    }
    return { ...rest, contentBase64: null, extractedText: text.slice(0, MAX_EXTRACTED_CHARS), extractionError: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ...rest, contentBase64: null, extractionError: detail.slice(0, 500) }
  }
}
