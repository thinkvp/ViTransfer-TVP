/**
 * Client-side .docx → safe HTML conversion for the document viewer.
 *
 * Runs in the browser on purpose. Converting server-side would mean the app fetching the
 * file out of S3 on every preview, which is exactly the round-trip the viewer is built to
 * avoid; here the bytes reach the browser straight from storage (the download route
 * redirects to a presigned URL) and only the conversion happens locally. It also keeps the
 * feature off the API surface entirely — no new endpoint means no new authorization to get
 * wrong.
 *
 * mammoth is already a dependency (the AI assistant extracts text with it) and ships a
 * `browser` field remapping its two Node-only modules, so the bundler resolves a browser
 * build without extra configuration. It is imported dynamically so it only loads when
 * someone actually opens a Word document.
 */

import DOMPurify from 'dompurify'
import { isSafeInlineImageSrc, isSafeLinkHref } from '@/lib/document-preview'

/**
 * Word files are zipped XML and expand substantially in memory during conversion, so the
 * ceiling is lower than the viewer's general buffered limit.
 */
export const MAX_DOCX_PREVIEW_BYTES = 25 * 1024 * 1024

/**
 * Tags mammoth can emit, plus the table markup it produces for Word tables. No <style>,
 * no <script>, and no style attribute — a converted document must not be able to restyle
 * the surrounding admin UI, let alone run anything.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'a', 'img', 'blockquote', 'pre', 'code',
]

const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'colspan', 'rowspan']

/**
 * URL filtering is deliberately NOT done with DOMPurify's ALLOWED_URI_REGEXP. That option
 * is tested against every attribute value, not just URI-bearing ones, so it silently
 * strips things like colspan="2"; and it is bypassed entirely for `data:` on <img>, which
 * is the one case that actually needs guarding. Both were confirmed by test. The pass below
 * enforces the policy explicitly instead, using predicates that can be unit-tested.
 */
function enforceUrlPolicy(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // A picture we cannot vouch for is dropped rather than left as a broken image.
  doc.querySelectorAll('img').forEach((img) => {
    if (!isSafeInlineImageSrc(img.getAttribute('src'))) img.remove()
  })

  // A link we cannot vouch for keeps its text but loses its destination.
  doc.querySelectorAll('a[href]').forEach((anchor) => {
    if (!isSafeLinkHref(anchor.getAttribute('href'))) {
      anchor.removeAttribute('href')
      anchor.removeAttribute('target')
      anchor.removeAttribute('rel')
      return
    }
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer nofollow')
  })

  return doc.body.innerHTML
}

export interface DocxPreviewResult {
  html: string
  /** Conversion notes mammoth reports (unsupported styles and the like). */
  warnings: string[]
}

export async function convertDocxToSafeHtml(bytes: ArrayBuffer): Promise<DocxPreviewResult> {
  const mod: any = await import('mammoth')
  const mammoth = mod?.default ?? mod

  const result = await mammoth.convertToHtml({ arrayBuffer: bytes })
  const rawHtml: string = result?.value ?? ''

  const html = enforceUrlPolicy(
    DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      FORCE_BODY: true,
    })
  )

  const warnings: string[] = Array.isArray(result?.messages)
    ? result.messages
        .filter((m: any) => m?.type === 'warning' || m?.type === 'error')
        .map((m: any) => String(m?.message ?? ''))
        .filter(Boolean)
    : []

  return { html, warnings }
}
