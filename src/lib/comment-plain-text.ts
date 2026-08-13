/**
 * Comment content → plain text.
 *
 * Comment bodies are stored as sanitized HTML (`contentSchema` in @/lib/validation and
 * `sanitizeCommentHtml` in @/lib/security/html-sanitization). The editors are plain
 * textareas, so DOMPurify escapes the text on write: a typed `&` is stored as `&amp;`,
 * `<` as `&lt;`, and so on.
 *
 * Display surfaces that use `dangerouslySetInnerHTML` (MessageBubble, ProjectInternalComments)
 * get that unescaped for free by the browser. Anywhere that renders the content as TEXT —
 * reply previews, timeline tooltips, feedback lists, kanban comments — must undo the escaping
 * here, otherwise the client literally sees `EHS &amp; Sustainability`.
 *
 * Deliberately DOM-free so it works identically on the server, during SSR, and in the browser.
 *
 * SECURITY: the output is unescaped text — `&lt;script&gt;` comes back as `<script>`. Render it
 * as text (JSX `{...}`, textContent) only. Never feed it to dangerouslySetInnerHTML; use
 * sanitizeCommentHtml for that.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Decode the entities DOMPurify can emit, in a single left-to-right pass so nothing is
 * decoded twice — `&amp;lt;` must come back as the literal text `&lt;`, not as `<`.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/** Strip the allowed formatting tags and unescape entities, keeping line breaks. */
export function commentHtmlToPlainText(input: unknown): string {
  const html = String(input ?? '')
  if (!html) return ''

  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, '')

  return decodeHtmlEntities(withBreaks)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Same, collapsed onto a single line — for tooltips and one-line previews. */
export function commentHtmlToPreviewText(input: unknown): string {
  return commentHtmlToPlainText(input).replace(/\s+/g, ' ').trim()
}
