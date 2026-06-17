/**
 * Centralized DOMPurify hook configuration
 *
 * Single source of truth for all global DOMPurify hooks.
 * DOMPurify.addHook() is idempotent — calling it multiple times with the
 * same hook name is safe and only registers once per instance.
 *
 * SECURITY: DOMPurify hooks are global per instance. This module must be
 * imported before any sanitization call to ensure hooks are registered.
 * Call ensureDomPurifyHooksRegistered() at the top of each sanitize function.
 */

import DOMPurify from 'isomorphic-dompurify'

/**
 * Ensure the shared DOMPurify hooks are registered.
 * Safe to call multiple times — DOMPurify deduplicates by hook name.
 *
 * Hook policy:
 * - External HTTP/HTTPS links (<a>): enforce target="_blank" and
 *   rel="noopener noreferrer nofollow"
 * - Internal links (/ or #): strip target and rel attributes
 * - Malformed target="_blank" on non-external links: add noopener noreferrer
 */
export function ensureDomPurifyHooksRegistered(): void {
  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    if (!node?.tagName) return

    // ── Link safety ──────────────────────────────────────────────────────
    if (node.tagName === 'A') {
      const href = (node.getAttribute?.('href') || '').toString()
      const target = (node.getAttribute?.('target') || '').toString()

      const isInternal = href.startsWith('/') || href.startsWith('#')
      const isHttpLink = href.startsWith('http://') || href.startsWith('https://')

      if (isHttpLink && !isInternal) {
        node.setAttribute?.('target', '_blank')
        node.setAttribute?.('rel', 'noopener noreferrer nofollow')
        return
      }

      if (target === '_blank') {
        node.setAttribute?.('rel', 'noopener noreferrer nofollow')
      } else {
        node.removeAttribute?.('target')
        node.removeAttribute?.('rel')
      }
      return
    }
  })
}
