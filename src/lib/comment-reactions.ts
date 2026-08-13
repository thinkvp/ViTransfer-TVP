/**
 * Comment emoji reactions — shared allowlist and DTO shaping.
 *
 * Dependency-free (no Prisma, no server-only imports) so both the API routes and the
 * client bundle can import it: the server validates against REACTION_EMOJIS, and the UI
 * renders the picker from the same array, which is what keeps the two in step.
 *
 * `emoji` is never free text. Anything outside the allowlist is rejected at the route,
 * so no emoji sanitization/normalization is needed downstream.
 */

/**
 * The fixed reaction set. Order is display order — pills render in this order rather than
 * by count, so a pill never jumps position when someone else reacts.
 *
 * Appending is safe. Removing or reordering is not purely cosmetic: existing rows keep the
 * old emoji and would stop rendering (removal) or shuffle for everyone (reorder).
 */
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '👀', '🤔', '🔥'] as const

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

export function isAllowedReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJIS as readonly string[]).includes(value)
}

/**
 * Per-emoji rollup attached to a sanitized comment.
 *
 * `reactorNames` is PII and is populated for admin viewers only, consistent with the
 * zero-PII policy in comment-sanitization.ts — clients see counts and their own state.
 */
export interface CommentReactionSummary {
  emoji: string
  count: number
  /** Whether the requesting viewer's own identity is among the reactors. */
  viewerReacted: boolean
  /**
   * Names of the OTHER reactors — the viewer's own name is deliberately omitted, so the UI
   * can render "You and Sarah Mitchell" without having to work out which entry is theirs
   * (two recipients can share a display name).
   *
   * Populated for admins and authenticated share viewers, who already see comment author
   * names; absent for anonymous viewers, who see 'Client'/'Admin' for comments too.
   */
  reactorNames?: string[]
}

/** Raw reaction row shape needed to build summaries (matches the route/list select). */
export interface RawCommentReaction {
  commentId: string
  emoji: string
  userId?: string | null
  recipientId?: string | null
  user?: { name?: string | null; email?: string | null } | null
  recipient?: { name?: string | null; email?: string | null } | null
}

/** The requesting viewer's reaction identity. Both null = viewer cannot have reacted. */
export interface ReactionViewer {
  userId?: string | null
  recipientId?: string | null
}

function reactorLabel(row: RawCommentReaction): string {
  const author = row.userId ? row.user : row.recipient
  return author?.name || author?.email || 'Unknown'
}

/**
 * Roll raw reaction rows up into per-comment summaries.
 *
 * Takes rows for an entire comment list (parents and replies together) in one pass, so a
 * list request needs exactly one reaction query regardless of thread depth.
 */
export function buildReactionSummaries(
  rows: RawCommentReaction[],
  viewer: ReactionViewer,
  // Whether this audience may see reactor names. Mirrors the authorName rule in
  // comment-sanitization.ts (isAdmin || isAuthenticated) rather than adding a second,
  // different PII rule for the same set of people.
  includeNames: boolean,
): Map<string, CommentReactionSummary[]> {
  // commentId -> emoji -> summary. Keyed maps rather than array scans because a busy
  // project can carry a few thousand rows across a video's comment list.
  const byComment = new Map<string, Map<string, CommentReactionSummary>>()

  for (const row of rows) {
    if (!row?.commentId || !isAllowedReactionEmoji(row.emoji)) continue

    let emojiMap = byComment.get(row.commentId)
    if (!emojiMap) {
      emojiMap = new Map()
      byComment.set(row.commentId, emojiMap)
    }

    let summary = emojiMap.get(row.emoji)
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, viewerReacted: false }
      if (includeNames) summary.reactorNames = []
      emojiMap.set(row.emoji, summary)
    }

    summary.count += 1

    // Identity match is deliberately strict: a null viewer id must never match a null row
    // column, or every anonymous row would read back as "you reacted".
    const isViewer =
      (!!viewer.userId && row.userId === viewer.userId) ||
      (!!viewer.recipientId && row.recipientId === viewer.recipientId)
    if (isViewer) summary.viewerReacted = true

    // The viewer's own name is left out — viewerReacted already carries that, and the UI
    // renders it as "You".
    if (includeNames && !isViewer) summary.reactorNames!.push(reactorLabel(row))
  }

  const result = new Map<string, CommentReactionSummary[]>()
  for (const [commentId, emojiMap] of byComment) {
    // Emit in REACTION_EMOJIS order, not insertion order.
    const ordered = REACTION_EMOJIS.map((emoji) => emojiMap.get(emoji)).filter(
      (summary): summary is CommentReactionSummary => !!summary && summary.count > 0,
    )
    if (ordered.length > 0) result.set(commentId, ordered)
  }
  return result
}

/** Longest list rendered in a reaction tooltip before it collapses to "and N others". */
const MAX_TOOLTIP_NAMES = 5

/**
 * Human-readable "who reacted" label for a pill tooltip, e.g.
 * "You and Sarah Mitchell reacted".
 *
 * The emoji is deliberately not named — the tooltip only appears while pointing at it.
 *
 * Returns null when the viewer isn't allowed names and hasn't reacted themselves, so the
 * caller can fall back to the plain add/remove hint.
 */
export function formatReactionTooltip(summary: CommentReactionSummary): string | null {
  const others = summary.reactorNames || []
  const names = summary.viewerReacted ? ['You', ...others] : [...others]
  if (names.length === 0) return null

  // Only the names beyond the cap are folded into the remainder; the count is derived from
  // `count` rather than the array so it stays right even when names were withheld.
  const withheld = summary.count - names.length
  let shown = names
  let remainder = withheld

  if (names.length > MAX_TOOLTIP_NAMES) {
    shown = names.slice(0, MAX_TOOLTIP_NAMES)
    remainder += names.length - MAX_TOOLTIP_NAMES
  }

  const parts = remainder > 0 ? [...shown, `${remainder} other${remainder === 1 ? '' : 's'}`] : shown
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

  return `${list} reacted`
}

/**
 * Apply the viewer's own add/remove to a summary list, client-side.
 *
 * Used for the optimistic update so a pill responds on click instead of after the round
 * trip. The server response (and the SSE-driven refetch behind it) overwrite this shortly
 * after, so it only has to be right for the viewer's own contribution — reactorNames is
 * deliberately left untouched rather than guessed at.
 */
export function applyViewerReaction(
  summaries: CommentReactionSummary[],
  emoji: string,
  nextActive: boolean,
): CommentReactionSummary[] {
  if (!isAllowedReactionEmoji(emoji)) return summaries

  const next = summaries.map((summary) => ({ ...summary }))
  const existing = next.find((summary) => summary.emoji === emoji)

  if (nextActive) {
    if (existing) {
      // Already counted for this viewer — nothing to add (matches the idempotent POST).
      if (!existing.viewerReacted) {
        existing.count += 1
        existing.viewerReacted = true
      }
    } else {
      next.push({ emoji, count: 1, viewerReacted: true })
    }
  } else if (existing?.viewerReacted) {
    existing.count -= 1
    existing.viewerReacted = false
  }

  const surviving = next.filter((summary) => summary.count > 0)
  return REACTION_EMOJIS.map((allowed) => surviving.find((summary) => summary.emoji === allowed)).filter(
    (summary): summary is CommentReactionSummary => !!summary,
  )
}

/**
 * Collect every comment id in a (possibly threaded) comment list, so reactions for parents
 * and replies can be fetched in a single query.
 */
export function collectCommentIds(comments: Array<{ id: string; replies?: Array<{ id: string }> }>): string[] {
  const ids: string[] = []
  for (const comment of comments) {
    if (!comment?.id) continue
    ids.push(comment.id)
    if (Array.isArray(comment.replies)) {
      for (const reply of comment.replies) {
        if (reply?.id) ids.push(reply.id)
      }
    }
  }
  return ids
}
