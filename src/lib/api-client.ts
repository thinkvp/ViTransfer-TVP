import {
  broadcastSessionExpired,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  isCurrentWindowSessionTimedOut,
  setTokens,
  subscribe,
  subscribeSessionExpired,
} from './token-store'

let isRedirecting = false
let refreshInFlight: Promise<boolean> | null = null

// ── Admin session halt ──────────────────────────────────────────────────────
// Set once this tab knows its admin session is gone: the refresh token was
// rejected, the inactivity monitor expired the window, or a sibling tab reported
// expiry. While set, apiFetch answers every non-auth request with a local 401
// instead of touching the network. Timers, token refreshers and players keep
// calling in until the page actually navigates away, and a burst of real POST
// 401s trips CrowdSec's http-generic-401-bf on the VPS (6 within ~10s → the
// whole IP is banned for 4h, SSH included).
let adminSessionHalted = false
const haltListeners = new Set<(halted: boolean) => void>()

function setAdminSessionHalted(halted: boolean) {
  if (adminSessionHalted === halted) return
  adminSessionHalted = halted
  // A soft navigation to /login keeps this module alive; let a later expiry redirect again.
  if (!halted) isRedirecting = false
  haltListeners.forEach(fn => fn(halted))
}

/**
 * Stop all admin-authenticated traffic from this tab until a new login.
 * Pass `navigating: true` when the caller is already sending the tab to /login.
 */
export function haltAdminSession(options?: { navigating?: boolean }) {
  if (options?.navigating) isRedirecting = true
  setAdminSessionHalted(true)
}

export function isAdminSessionHalted(): boolean {
  return adminSessionHalted
}

export function subscribeAdminSessionHalt(listener: (halted: boolean) => void): () => void {
  haltListeners.add(listener)
  return () => haltListeners.delete(listener)
}

if (typeof window !== 'undefined') {
  // A fresh login here or in a sibling window lifts the halt. getAccessToken()
  // (not the snapshot) so a window the inactivity monitor expired stays halted
  // when a sibling merely rotates the shared token.
  subscribe(() => {
    if (adminSessionHalted && getAccessToken()) setAdminSessionHalted(false)
  })
  // A sibling found the shared session dead. 'expired' arrives before the
  // matching 'clear', so holding tokens here means this tab was using it.
  subscribeSessionExpired(() => {
    if (getAccessToken() || getRefreshToken()) haltAdminSession()
  })
}

/**
 * `onAuthError` for admin-authenticated project event streams: rotate the access
 * token for the next reconnect, or return false (close the stream) when there is
 * no session left to recover — retrying a dead session's 401 forever helps no one.
 */
export function handleAdminStreamAuthError(): boolean {
  if (adminSessionHalted || !getRefreshToken()) return false
  void attemptRefresh()
  return true
}

/** Decode the exp claim from a JWT without verifying the signature. */
export function getJwtExpMs(token: string): number | null {
  try {
    const b64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    if (!b64) return null
    const payload = JSON.parse(atob(b64))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

// Treat a token this close to exp as already expired (clock skew + request latency).
const JWT_EXPIRY_SKEW_MS = 10_000

function isJwtExpired(token: string): boolean {
  const expMs = getJwtExpMs(token)
  return expMs !== null && expMs - JWT_EXPIRY_SKEW_MS <= Date.now()
}

function sessionHaltedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Session expired' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

// Stable toast id so repeated denials replace the existing toast instead of stacking.
const READ_ONLY_TOAST_ID = 'rbac-read-only'

/**
 * Surface an RBAC read-only denial (403 with `readOnly: true`) as a toast.
 *
 * This lives in the fetch layer on purpose: most write handlers across the admin
 * UI wrap their calls in `try { … } finally { … }` with no `catch`, so a rejected
 * write would otherwise fail completely silently — the user clicks Save and
 * nothing at all happens. Handling it here guarantees feedback on every write
 * path without auditing ~90 call sites.
 */
async function notifyIfReadOnlyDenied(response: Response): Promise<void> {
  if (response.status !== 403) return
  try {
    const body = await response.clone().json()
    if (!body?.readOnly) return
    const message = typeof body.error === 'string' && body.error
      ? body.error
      : 'Your account has read-only access.'
    // Imported lazily to keep the UI toast library out of this module's graph for
    // every other request (and out of any server-side importer).
    const { toast } = await import('sonner')
    toast.error(message, { id: READ_ONLY_TOAST_ID })
  } catch {
    // Non-JSON or unreadable body — nothing to surface.
  }
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // Capture whether this caller has admin (user) tokens before the request so
  // we can still fire the session-expired redirect for admins who happen to be
  // viewing a share page when their own session expires.
  const hadAdminTokens = !!(getAccessToken() || getRefreshToken())
  const url = requestUrl(input)
  const isAuthEndpoint = url.includes('/api/auth')

  if (adminSessionHalted && !isAuthEndpoint) {
    redirectToLogin()
    return sessionHaltedResponse()
  }

  // After the machine sleeps, the in-memory access token is usually past its
  // exp. Sending it anyway guarantees one 401 per in-flight request (several
  // POSTs at once on wake), so refresh first. All callers share one refresh.
  if (!isAuthEndpoint && !new Headers(init?.headers || {}).has('Authorization')) {
    const token = getAccessToken()
    if (token && isJwtExpired(token)) {
      await attemptRefresh()
      if (adminSessionHalted) {
        redirectToLogin()
        return sessionHaltedResponse()
      }
    }
  }

  const requestInit = withAuthHeader(init)

  try {
    const response = await fetch(input, requestInit)

    if (response.status === 401) {
      // Never re-send a 401'd request blind: only retry once, and only after a
      // refresh actually produced a new access token.
      const refreshed = await attemptRefresh()
      if (refreshed) {
        const retryResponse = await fetch(input, withAuthHeader(init))
        if (retryResponse.status !== 401) {
          await notifyIfReadOnlyDenied(retryResponse)
          return retryResponse
        }
      }

      // Share visitors (no admin tokens) on share pages should NOT be
      // redirected to /login — the share page itself shows the re-auth form.
      // But admins who happen to be on a share page still need the login redirect.
      const isSharePageWithoutAdminSession =
        typeof window !== 'undefined' &&
        window.location.pathname.startsWith('/share/') &&
        !hadAdminTokens
      if (!isSharePageWithoutAdminSession && !isAuthEndpoint && !isRedirecting) {
        if (!getAccessToken() && !getRefreshToken()) {
          // Don't broadcast a global logout if this window's session was already
          // locally expired by the inactivity monitor — that would log out every
          // other active browser window sharing the same origin. Still stop this
          // tab's own traffic and send it to the login page.
          if (!isCurrentWindowSessionTimedOut()) {
            handleSessionExpired()
          } else {
            redirectToLogin()
          }
        }
      }
    }

    await notifyIfReadOnlyDenied(response)

    return response
  } catch (error) {
    console.error('[API] Request failed:', error)
    throw error
  }
}

/**
 * True when this error came from an RBAC read-only denial that apiFetch has
 * already surfaced as a toast. Callers that show their own error toast should
 * skip it for these, or the user sees the same message twice.
 */
export function isReadOnlyDenial(error: unknown): boolean {
  return !!(error && typeof error === 'object' && (error as { readOnly?: boolean }).readOnly === true)
}

export async function apiJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const response = await apiFetch(input, init)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    const thrown = new Error(error.error || `HTTP ${response.status}`)
    if (error?.readOnly) (thrown as Error & { readOnly?: boolean }).readOnly = true
    throw thrown
  }

  return response.json()
}

export async function apiPost<T = any>(
  url: string,
  data: any,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(data),
  })
}

export async function apiPatch<T = any>(
  url: string,
  data: any,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(data),
  })
}

export async function apiDelete<T = any>(
  url: string,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'DELETE',
    headers: {
      ...init?.headers,
    },
  })
}

function withAuthHeader(init?: RequestInit): RequestInit {
  const token = getAccessToken()
  const headers = new Headers(init?.headers || {})
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return { ...init, headers }
}

export async function attemptRefresh(): Promise<boolean> {
  if (adminSessionHalted) return false
  if (refreshInFlight) return refreshInFlight

  const presentedRefreshToken = getRefreshToken()
  if (!presentedRefreshToken) return false

  refreshInFlight = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${presentedRefreshToken}`,
        },
      })

      if (!response.ok) {
        // Token rotation can race across concurrent refresh attempts.
        // If another refresh already succeeded and updated the token store,
        // try again with the latest refresh token before clearing.
        const currentRefreshToken = getRefreshToken()
        const refreshWasRotatedElsewhere = !!(currentRefreshToken && currentRefreshToken !== presentedRefreshToken)
        if (refreshWasRotatedElsewhere) {
          try {
            const retryResponse = await fetch('/api/auth/refresh', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${currentRefreshToken}`,
              },
            })

            if (retryResponse.ok) {
              const retryData = await retryResponse.json()
              if (retryData?.tokens?.accessToken && retryData?.tokens?.refreshToken) {
                setTokens({
                  accessToken: retryData.tokens.accessToken,
                  refreshToken: retryData.tokens.refreshToken,
                })
                return true
              }
            }
          } catch {
            // Ignore retry errors and fall through to normal handling.
          }
        }

        // Only clear tokens when the refresh token is truly invalid.
        if (response.status === 401 || response.status === 403) {
          const latestRefreshToken = getRefreshToken()
          if (!latestRefreshToken || latestRefreshToken === presentedRefreshToken) {
            // Don't broadcast a global token clear if this window's inactivity
            // timer already expired the local session — getRefreshToken() returns
            // null in that state, which would otherwise look identical to a genuine
            // revocation and wipe every other open window.
            if (!isCurrentWindowSessionTimedOut()) {
              // The session is definitively dead: stop this tab and its siblings
              // now, before their timers each discover it with a 401 of their own.
              broadcastSessionExpired()
              haltAdminSession()
              clearTokens()
            }
          }
        }
        return false
      }

      const data = await response.json()
      if (data?.tokens?.accessToken && data?.tokens?.refreshToken) {
        setTokens({
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
        })
        return true
      }

      clearTokens()
      return false
    } catch (error) {
      console.error('[API] Failed to refresh token:', error)

      // If another refresh already succeeded, keep the session.
      const currentRefreshToken = getRefreshToken()
      const currentAccessToken = getAccessToken()
      const refreshWasRotatedElsewhere = !!(currentRefreshToken && currentRefreshToken !== presentedRefreshToken)
      if (currentAccessToken && refreshWasRotatedElsewhere) {
        return true
      }

      // Network errors should not immediately wipe tokens.
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

function handleSessionExpired() {
  if (isRedirecting) return

  try {
    broadcastSessionExpired()
    clearTokens()
    localStorage.removeItem('vitransfer_preferences')
    sessionStorage.clear()
  } catch (error) {
    // ignore
  }

  redirectToLogin()
}

// Halt this tab's traffic and send it to the login page (once). Doesn't touch
// tokens or other windows — handleSessionExpired does that for a real expiry.
function redirectToLogin() {
  haltAdminSession()
  if (isRedirecting) return
  if (typeof window === 'undefined') return
  if (window.location.pathname.startsWith('/login')) return
  isRedirecting = true
  // A hard navigation is deliberate here: it tears down all React state holding data the
  // expired session fetched. This module is also outside React, so useRouter() isn't available.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = '/login?sessionExpired=true'
}
