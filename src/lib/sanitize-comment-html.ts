/**
 * Client-side comment HTML sanitization.
 *
 * Defense in depth: comment content is already sanitized on write (contentSchema in
 * @/lib/validation), but components render it via dangerouslySetInnerHTML, so we
 * sanitize again at render time. This guarantees a future write path that bypasses
 * validation can never become stored XSS.
 *
 * Shared by MessageBubble and ProjectInternalComments.
 */
import DOMPurify from 'dompurify'

let domPurifyConfigured = false

function configureDomPurify() {
  if (domPurifyConfigured) return
  domPurifyConfigured = true

  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    if (!node || node.tagName !== 'A') return

    const href = (node.getAttribute?.('href') || '').toString()
    const target = (node.getAttribute?.('target') || '').toString()

    const isInternal = href.startsWith('/') || href.startsWith('#')
    const isHttpLink = href.startsWith('http://') || href.startsWith('https://')

    // For external http(s) links, force new tab + safe rel.
    if (isHttpLink && !isInternal) {
      node.setAttribute?.('target', '_blank')
      node.setAttribute?.('rel', 'noopener noreferrer nofollow')
      return
    }

    // For any other link, only allow target=_blank if rel is safe.
    if (target === '_blank') {
      node.setAttribute?.('rel', 'noopener noreferrer nofollow')
    } else {
      node.removeAttribute?.('target')
      node.removeAttribute?.('rel')
    }
  })
}

/** Sanitize comment HTML for display, allowing only safe formatting tags. */
export function sanitizeCommentHtml(content: string): string {
  configureDomPurify()
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i, // Only allow https://, http://, mailto: URLs
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true, // Parse content as body to prevent context-breaking attacks
  })
}
