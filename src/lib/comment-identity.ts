/**
 * Share-session comment identity (browser only).
 *
 * A share visitor picks who they are — a named ProjectRecipient, or a free-typed name with
 * no recipient — and that choice is persisted in sessionStorage by both
 * `useCommentManagement` and the share page. This module is the one place that key is
 * spelled out, and the one place comment fetches read it back.
 *
 * The recipient id has to ride along on comment list requests because reactions are
 * attributable: without it the server cannot tell which pills are the viewer's own, and
 * every reaction reads back as someone else's. The server validates the id against the
 * project before trusting it (see hydrateCommentReactions), so sending it is not a
 * permission claim — it only answers "which of these reactions are mine".
 */

export function commentIdentityStorageKey(projectId: string): string {
  return `comment-name-${projectId}`
}

export function readPersistedRecipientId(projectId: string): string | null {
  if (typeof window === 'undefined' || !projectId) return null
  try {
    const stored = sessionStorage.getItem(commentIdentityStorageKey(projectId))
    if (!stored) return null
    const parsed = JSON.parse(stored)
    return typeof parsed?.recipientId === 'string' && parsed.recipientId ? parsed.recipientId : null
  } catch {
    return null
  }
}

/**
 * Append the viewer's recipient id to a comment-list URL, if they have picked one.
 * No-op on the server and for viewers who never identified themselves.
 */
export function withCommentIdentity(url: string, projectId: string): string {
  const recipientId = readPersistedRecipientId(projectId)
  if (!recipientId) return url
  return `${url}${url.includes('?') ? '&' : '?'}recipientId=${encodeURIComponent(recipientId)}`
}
