import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './token-store'

let isRedirecting = false
let refreshInFlight: Promise<boolean> | null = null

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const requestInit = withAuthHeader(init)

  try {
    const response = await fetch(input, requestInit)

    if (response.status === 401) {
      const refreshed = await attemptRefresh()
      if (refreshed) {
        const retryResponse = await fetch(input, withAuthHeader(init))
        if (retryResponse.status !== 401) {
          return retryResponse
        }
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const isSharePage = typeof window !== 'undefined' && window.location.pathname.startsWith('/share/')
      const isAuthEndpoint = url.includes('/api/auth')
      if (!isSharePage && !isAuthEndpoint && !isRedirecting) {
        if (!getAccessToken() && !getRefreshToken()) {
          handleSessionExpired()
        }
      }
    }

    return response
  } catch (error) {
    console.error('[API] Request failed:', error)
    throw error
  }
}

export async function apiJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const response = await apiFetch(input, init)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
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
  if (token) {
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
            clearTokens()
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
