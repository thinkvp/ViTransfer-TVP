import { clearTokens, getAccessToken, getRefreshToken, isCurrentWindowSessionTimedOut, setTokens } from './token-store'

let isRedirecting = false
let refreshInFlight: Promise<boolean> | null = null

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

  const requestInit = withAuthHeader(init)

  try {
    const response = await fetch(input, requestInit)

    if (response.status === 401) {
      const refreshed = await attemptRefresh()
      if (refreshed) {
        const retryResponse = await fetch(input, withAuthHeader(init))
        if (retryResponse.status !== 401) {
          await notifyIfReadOnlyDenied(retryResponse)
          return retryResponse
        }
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      // Share visitors (no admin tokens) on share pages should NOT be
      // redirected to /login — the share page itself shows the re-auth form.
      // But admins who happen to be on a share page still need the login redirect.
      const isSharePageWithoutAdminSession =
        typeof window !== 'undefined' &&
        window.location.pathname.startsWith('/share/') &&
        !hadAdminTokens
      const isAuthEndpoint = url.includes('/api/auth')
      if (!isSharePageWithoutAdminSession && !isAuthEndpoint && !isRedirecting) {
        if (!getAccessToken() && !getRefreshToken()) {
          // Don't broadcast a global logout if this window's session was already
          // locally expired by the inactivity monitor — that would log out every
          // other active browser window sharing the same origin.
          if (!isCurrentWindowSessionTimedOut()) {
            handleSessionExpired()
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
  isRedirecting = true

  try {
    clearTokens()
    localStorage.removeItem('vitransfer_preferences')
    sessionStorage.clear()
  } catch (error) {
    // ignore
  }

  if (typeof window !== 'undefined') {
    window.location.href = '/login?sessionExpired=true'
  }
}
