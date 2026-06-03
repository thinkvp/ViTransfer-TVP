import DOMPurify from 'isomorphic-dompurify'
import { ensureDomPurifyHooksRegistered } from './dompurify-config'

let domPurifyConfigured = false

const MAX_EMAIL_HTML_CHARS = 1_000_000

function stripDataUrlsFast(html: string): string {
  // Some emails embed inline images as gigantic base64 `data:` URLs.
  // Even though DOMPurify would remove them (ALLOWED_URI_REGEXP blocks `data:`),
  // parsing/sanitizing multi-megabyte strings can block the Node event loop.

  let out = html

  // Remove data: URLs in common attributes.
  // Example: <img src="data:image/png;base64,..."> or <a href="data:...">
  out = out.replace(/\b(src|href)\s*=\s*(["'])\s*data:[\s\S]*?\2/gi, '$1=""')

  // Remove CSS data: URLs inside inline style attributes.
  // Example: style="background-image:url(data:image/png;base64,...)"
  out = out.replace(/url\(\s*(["'])?\s*data:[\s\S]*?\1?\s*\)/gi, 'url()')

  return out
}

function configureDomPurifyOnce() {
  if (domPurifyConfigured) return
  domPurifyConfigured = true

  // Register shared link-safety hooks from the central config.
  ensureDomPurifyHooksRegistered()

  // Register email-specific hooks (block remote images).
  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    if (!node?.tagName) return

    // Block remote image loading and tracking pixels.
    if (node.tagName === 'IMG') {
      const src = (node.getAttribute?.('src') || '').toString()

      // Allow only our own inline-attachment endpoints (relative URLs).
      const allowed = src.startsWith('/api/projects/')
      if (!allowed) {
        node.removeAttribute?.('src')
      }

      // Strip srcset to avoid remote loads.
      node.removeAttribute?.('srcset')
      return
    }
  })
}

/**
 * Sanitize imported email HTML for safe display.
 * - Allows common formatting/layout tags
 * - Blocks scripts/forms/iframes
 * - Blocks remote images (only allows our inline attachment endpoint)
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html || typeof html !== 'string') return ''

  // Fast pre-pass to avoid extremely expensive sanitization on huge inputs.
  // If still too large after stripping data: URLs, fall back to empty HTML
  // so the UI can render the plain text body instead.
  const pre = stripDataUrlsFast(html)
  if (pre.length > MAX_EMAIL_HTML_CHARS) {
    return ''
  }

  configureDomPurifyOnce()

  const clean = DOMPurify.sanitize(pre, {
    ALLOWED_TAGS: [
      'a',
      'abbr',
      'b',
      'blockquote',
      'br',
      'code',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'i',
      'li',
      'ol',
      'p',
      'pre',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'u',
      'ul',
    ],
    FORBID_TAGS: ['img'],
    ALLOWED_ATTR: [
      'href',
      'title',
      'target',
      'rel',
      'style',
      'class',
      'id',
    ],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/|#)/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SAFE_FOR_TEMPLATES: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    FORCE_BODY: false,
  })

  return clean.trim()
}
